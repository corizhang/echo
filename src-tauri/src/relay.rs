use crate::diagnostics;
use futures_util::{stream::BoxStream, Sink, SinkExt, StreamExt};
use quinn::Endpoint;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerNetwork {
    role: String,
    #[serde(default)]
    member_id: String,
    #[serde(default)]
    is_self: bool,
    rtt_ms: Option<u64>,
    jitter_ms: Option<u64>,
    missed_pongs: u64,
    #[serde(default)]
    rtt_history: Vec<NetworkSample>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    at: u64,
    rtt_ms: u64,
    ping_id: String,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPingSample {
    at: u64,
    ping_id: String,
    processing_ms: f64,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    room_id: String,
    phase: String,
    role: String,
    detail: String,
    transport: String,
    peers: usize,
    advertisements: u64,
    sent_bytes: u64,
    received_bytes: u64,
    local_port: u16,
    fallback_eligible: bool,
    game_started: bool,
    peer_network: Vec<PeerNetwork>,
    client_ping_samples: Vec<ClientPingSample>,
}
impl Default for RelayStatus {
    fn default() -> Self {
        Self {
            room_id: String::new(),
            phase: "idle".into(),
            role: String::new(),
            detail: "尚未开启联机".into(),
            transport: String::new(),
            peers: 0,
            advertisements: 0,
            sent_bytes: 0,
            received_bytes: 0,
            local_port: 0,
            fallback_eligible: false,
            game_started: false,
            peer_network: Vec::new(),
            client_ping_samples: Vec::new(),
        }
    }
}
#[derive(Default)]
pub struct Relay {
    status: Arc<Mutex<RelayStatus>>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
fn update(s: &Arc<Mutex<RelayStatus>>, phase: &str, detail: &str) {
    let mut state = s.lock().unwrap();
    state.phase = phase.into();
    state.detail = detail.into();
}
#[tauri::command]
pub fn relay_status(state: tauri::State<Mutex<Relay>>) -> RelayStatus {
    state.lock().unwrap().status.lock().unwrap().clone()
}
#[tauri::command]
pub fn start_relay(
    state: tauri::State<Mutex<Relay>>,
    room_id: String,
    ticket: String,
    transport_mode: String,
) -> Result<(), String> {
    diagnostics::info(
        "start_relay",
        &format!("command received; room_id={room_id}"),
    );
    if ticket.len() > 128 || ticket.len() < 32 || room_id.len() > 100 {
        diagnostics::error("start_relay", "rejected invalid room credentials");
        return Err("无效的房间凭据".into());
    }
    if !["auto", "wss", "quic-compat"].contains(&transport_mode.as_str()) {
        return Err("无效的中转传输偏好".into());
    }
    let mut relay = state.lock().unwrap();
    if relay
        .task
        .as_ref()
        .is_some_and(|t| !t.inner().is_finished())
    {
        diagnostics::error(
            "start_relay",
            "rejected because another relay task is running",
        );
        return Err("请先断开当前联机通道".into());
    }
    let status = Arc::new(Mutex::new(RelayStatus {
        room_id,
        phase: "connecting".into(),
        detail: "正在连接中转服务".into(),
        ..Default::default()
    }));
    let (tx, rx) = oneshot::channel();
    relay.stop = Some(tx);
    relay.status = status.clone();
    relay.task = Some(tauri::async_runtime::spawn(async move {
        match run(status.clone(), ticket, transport_mode, rx).await {
            Ok(()) => {
                diagnostics::info("relay_task", "relay stopped normally");
                update(&status, "idle", "联机通道已关闭");
            }
            Err(error) => {
                diagnostics::error("relay_task", &error);
                update(&status, "error", &error);
            }
        }
    }));
    diagnostics::info("start_relay", "relay task spawned");
    Ok(())
}
#[tauri::command]
pub fn stop_relay(state: tauri::State<Mutex<Relay>>) {
    if let Some(stop) = state.lock().unwrap().stop.take() {
        let _ = stop.send(());
    }
}

async fn send<S>(sink: &mut S, message: Message) -> Result<(), String>
where
    S: Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    tokio::time::timeout(Duration::from_secs(5), sink.send(message))
        .await
        .map_err(|_| "中转写入超时，请重新连接".to_string())?
        .map_err(|e| e.to_string())
}
fn frame(kind: u8, id: u32, bytes: &[u8]) -> Message {
    let mut v = Vec::with_capacity(bytes.len() + 5);
    v.push(kind);
    v.extend(id.to_le_bytes());
    v.extend(bytes);
    Message::Binary(v.into())
}
type RelaySink = std::pin::Pin<Box<dyn Sink<Message, Error = String> + Send>>;
type RelayStream = BoxStream<'static, Result<Message, String>>;

enum HostSocketCommand {
    Write(Vec<u8>),
    Close,
}
enum HostSocketEvent {
    Data(u32, Vec<u8>),
    Closed(u32, String),
}

fn spawn_host_socket(
    socket: TcpStream,
    stream_id: u32,
    mut commands: mpsc::Receiver<HostSocketCommand>,
    events: mpsc::Sender<HostSocketEvent>,
) {
    tauri::async_runtime::spawn(async move {
        let (mut read_socket, mut write_socket) = socket.into_split();
        let mut buffer = vec![0u8; 32768];
        loop {
            tokio::select! {
                read = read_socket.read(&mut buffer) => match read {
                    Ok(0) => { let _ = events.send(HostSocketEvent::Closed(stream_id, "local game socket reached EOF".into())); break; }
                    Ok(length) => { if events.send(HostSocketEvent::Data(stream_id, buffer[..length].to_vec())).await.is_err() { break; } }
                    Err(error) => { let _ = events.send(HostSocketEvent::Closed(stream_id, error.to_string())).await; break; }
                },
                command = commands.recv() => match command {
                    Some(HostSocketCommand::Write(bytes)) => match tokio::time::timeout(Duration::from_secs(5), write_socket.write_all(&bytes)).await {
                        Ok(Ok(())) => (),
                        Ok(Err(error)) => { let _ = events.send(HostSocketEvent::Closed(stream_id, error.to_string())).await; break; }
                        Err(_) => { let _ = events.send(HostSocketEvent::Closed(stream_id, "local game socket write timeout".into())).await; break; }
                    },
                    Some(HostSocketCommand::Close) | None => break,
                }
            }
        }
    });
}

async fn connect_websocket(
    endpoint: &str,
    ticket: &str,
) -> Result<(RelaySink, RelayStream), String> {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(65536);
    config.max_frame_size = Some(65536);
    let (ws, response) = tokio::time::timeout(
        Duration::from_secs(8),
        tokio_tungstenite::connect_async_with_config(endpoint, Some(config), true),
    )
    .await
    .map_err(|_| "中转连接超时")?
    .map_err(|e| format!("无法连接中转服务：{e}"))?;
    diagnostics::info(
        "relay",
        &format!("WSS fallback connected; http_status={}", response.status()),
    );
    let (mut tx, rx) = ws.split();
    tx.send(Message::Text(
        serde_json::json!({"ticket":ticket}).to_string().into(),
    ))
    .await
    .map_err(|e| e.to_string())?;
    let tx = Box::pin(tx.sink_map_err(|e| e.to_string()));
    let rx = rx.map(|item| item.map_err(|e| e.to_string())).boxed();
    Ok((tx, rx))
}

struct QuicSession {
    _endpoint: Endpoint,
    connection: quinn::Connection,
}
impl QuicSession {
    fn log(&self, event: &str) {
        diagnostics::info("quic_stats", &format!("event={event} connectionId={} remote={} closeReason={:?} stats={:?}", self.connection.stable_id(), self.connection.remote_address(), self.connection.close_reason(), self.connection.stats()));
    }
}
impl Drop for QuicSession {
    fn drop(&mut self) {
        self.log("session_end");
        self.connection.close(0u32.into(), b"relay session ended");
    }
}

async fn connect_quic(
    base: &str,
    ticket: &str,
    transport_mode: &str,
) -> Result<(RelaySink, RelayStream, QuicSession), String> {
    if transport_mode == "wss" {
        return Err("WSS/TCP selected by user".into());
    }
    if !base.starts_with("https://") {
        return Err("QUIC requires the configured HTTPS server origin".into());
    }
    let authority = base
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base)
        .split('/')
        .next()
        .unwrap_or("");
    let server_name = authority
        .split(':')
        .next()
        .unwrap_or("")
        .trim_matches(['[', ']']);
    if server_name.is_empty() {
        return Err("server name is empty".into());
    }
    let port = option_env!("ECHO_QUIC_PORT")
        .unwrap_or("40000")
        .parse::<u16>()
        .map_err(|e| e.to_string())?;
    let mut roots = rustls::RootCertStore::empty();
    let certificates = rustls_native_certs::load_native_certs();
    if certificates.certs.is_empty() {
        return Err("no trusted system certificates available".into());
    }
    for certificate in certificates.certs {
        let _ = roots.add(certificate);
    }
    let mut client_config = quinn::ClientConfig::with_root_certificates(std::sync::Arc::new(roots))
        .map_err(|e| e.to_string())?;
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(Duration::from_secs(5)));
    if transport_mode == "quic-compat" {
        transport.initial_mtu(1200).min_mtu(1200).mtu_discovery_config(None);
    }
    client_config.transport_config(Arc::new(transport));
    diagnostics::info("quic_config", &format!("mode={transport_mode} keepAliveSeconds=5 mtuDiscovery={}", transport_mode != "quic-compat"));
    let mut endpoint = Endpoint::client(
        "0.0.0.0:0"
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    endpoint.set_default_client_config(client_config);
    let addresses = tokio::net::lookup_host((server_name, port))
        .await
        .map_err(|e| e.to_string())?;
    let address = addresses
        .into_iter()
        .next()
        .ok_or("QUIC host did not resolve")?;
    let connection = endpoint
        .connect(address, server_name)
        .map_err(|e| e.to_string())?
        .await
        .map_err(|e| e.to_string())?;
    let session = QuicSession { _endpoint: endpoint, connection };
    session.log("handshake_complete");
    let (mut quic_tx, quic_rx) = session.connection.open_bi().await.map_err(|e| e.to_string())?;
    let auth = serde_json::json!({"ticket":ticket}).to_string();
    write_quic_message(&mut quic_tx, Message::Text(auth.into())).await?;
    let tx = futures_util::sink::unfold(quic_tx, |mut stream, message| async move {
        let result = write_quic_message(&mut stream, message).await;
        result.map(|()| stream)
    });
    let tx: RelaySink = Box::pin(tx);
    let rx = futures_util::stream::unfold(quic_rx, |mut stream| async move {
        let next = read_quic_message(&mut stream).await;
        Some((next, stream))
    })
    .boxed();
    Ok((tx, rx, session))
}

async fn write_quic_message(
    stream: &mut quinn::SendStream,
    message: Message,
) -> Result<(), String> {
    let (kind, payload) = match message {
        Message::Text(value) => (1u8, value.as_bytes().to_vec()),
        Message::Binary(value) => (2, value.to_vec()),
        Message::Ping(value) => (3, value.to_vec()),
        Message::Pong(value) => (4, value.to_vec()),
        Message::Close(value) => (
            5,
            value
                .map(|v| v.reason.to_string().into_bytes())
                .unwrap_or_default(),
        ),
        Message::Frame(_) => return Ok(()),
    };
    let length = payload
        .len()
        .checked_add(1)
        .filter(|n| *n <= 65536)
        .ok_or("QUIC frame too large")?;
    stream
        .write_u32(length as u32)
        .await
        .map_err(|e| e.to_string())?;
    stream.write_u8(kind).await.map_err(|e| e.to_string())?;
    stream
        .write_all(&payload)
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

async fn read_quic_message(stream: &mut quinn::RecvStream) -> Result<Message, String> {
    let length = stream.read_u32().await.map_err(|e| e.to_string())? as usize;
    if length == 0 || length > 65536 {
        return Err("invalid QUIC frame length".into());
    }
    let mut frame = vec![0u8; length];
    stream
        .read_exact(&mut frame)
        .await
        .map_err(|e| e.to_string())?;
    let payload = frame.split_off(1);
    Ok(match frame[0] {
        1 => Message::Text(
            String::from_utf8(payload)
                .map_err(|e| e.to_string())?
                .into(),
        ),
        2 => Message::Binary(payload.into()),
        3 => Message::Ping(payload.into()),
        4 => Message::Pong(payload.into()),
        5 => Message::Close(None),
        _ => return Err("invalid QUIC frame type".into()),
    })
}

// W3GS_GAMEINFO has two variable strings followed by a fixed 22-byte tail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GameInfo {
    port: u16,
    host_counter: u32,
    entry_key: u32,
}
fn game_info(p: &[u8]) -> Option<GameInfo> {
    if p.len() < 44
        || p.len() > 2048
        || p[0..2] != [0xf7, 0x30]
        || u16::from_le_bytes([p[2], p[3]]) as usize != p.len()
        || p[4..8] != *b"PX3W"
        || u32::from_le_bytes(p[8..12].try_into().ok()?) != 24
    {
        return None;
    }
    let name_end = p[20..].iter().position(|b| *b == 0)? + 20;
    if *p.get(name_end + 1)? != 0 {
        return None;
    }
    let stat_start = name_end + 2;
    let stat_end = p.get(stat_start..)?.iter().position(|b| *b == 0)? + stat_start;
    if p.len() != stat_end + 1 + 22 {
        return None;
    }
    let port = u16::from_le_bytes([p[p.len() - 2], p[p.len() - 1]]);
    // Only the classic Warcraft listen-port range, never arbitrary local services.
    (6112..=6119).contains(&port).then_some(GameInfo {
        port,
        host_counter: u32::from_le_bytes(p[12..16].try_into().ok()?),
        entry_key: u32::from_le_bytes(p[16..20].try_into().ok()?),
    })
}
async fn run(
    status: Arc<Mutex<RelayStatus>>,
    ticket: String,
    transport_mode: String,
    mut stop: oneshot::Receiver<()>,
) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = option_env!("ECHO_SERVER_URL")
        .unwrap_or("http://localhost:8080")
        .trim_end_matches('/');
    let ws_endpoint = format!("{}/api/v1/game-relay", base.replacen("http", "ws", 1));
    let (mut sink, mut source, quic_session, transport_name) = if transport_mode == "wss" || !base.starts_with("https://") {
        let (tx, rx) = tokio::select! {
            _ = &mut stop => return Ok(()),
            result = connect_websocket(&ws_endpoint, &ticket) => result?,
        };
        (tx, rx, None, "wss")
    } else {
        status.lock().unwrap().transport = "quic".into();
        diagnostics::info("relay", "attempting QUIC/UDP game relay");
        let attempt = tokio::select! {
            _ = &mut stop => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(3), connect_quic(base, &ticket, &transport_mode)) => result,
        };
        match attempt {
            Ok(Ok((tx, rx, session))) => {
                diagnostics::info("relay_transport", "QUIC/UDP connection established");
                (tx, rx, Some(session), "quic")
            }
            failed => {
                let reason = match failed { Ok(Err(error)) => error, _ => "QUIC handshake timed out".into() };
                status.lock().unwrap().fallback_eligible = true;
                // The ticket may already have been consumed. The UI obtains a fresh one for WSS.
                return Err(format!("QUIC connection failed: {reason}"));
            }
        }
    };
    diagnostics::info("relay", &format!("transport={transport_name}"));
    status.lock().unwrap().transport = transport_name.to_string();
    let udp = UdpSocket::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let proxy_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    diagnostics::info(
        "relay",
        &format!("local UDP and TCP proxy sockets bound; tcp_port={proxy_port}"),
    );
    status.lock().unwrap().local_port = proxy_port;
    let mut host = false;
    let mut ready = false;
    let mut advertisement: Option<(Vec<u8>, Instant)> = None;
    let mut host_port = None;
    let mut tcp: Option<TcpStream> = None;
    let mut guest_stream_ready = false;
    let mut stream_id = 0u32;
    let mut host_streams: HashMap<u32, mpsc::Sender<HostSocketCommand>> = HashMap::new();
    let (host_event_tx, mut host_event_rx) = mpsc::channel(64);
    let mut host_game_identity: Option<GameInfo> = None;
    let mut guest_game_identity: Option<GameInfo> = None;
    let mut host_advertisement_count = 0u64;
    let mut guest_advertisement_count = 0u64;
    let mut last_advertisement_summary = Instant::now();
    let mut last_relay_summary = Instant::now();
    let mut previous_sent_bytes = 0u64;
    let mut previous_received_bytes = 0u64;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut udp_buf = [0u8; 2049];
    let mut tcp_buf = [0u8; 32768];
    let search = [
        0xf7, 0x2f, 16, 0, b'P', b'X', b'3', b'W', 24, 0, 0, 0, 0, 0, 0, 0,
    ];
    let mut last_message = Instant::now();
    let mut received_messages = 0u64;
    let mut transport_failed = false;
    let mut last_ping_summary = Instant::now();
    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                _ = &mut stop => break Ok(()),
                _ = tick.tick() => {
                    if last_message.elapsed() > Duration::from_secs(35) { transport_failed = true; break Err("中转服务失去响应，请重新连接".into()); }
                    if last_relay_summary.elapsed() >= Duration::from_secs(15) {
                        if let Some(session) = &quic_session { session.log("window"); }
                        diagnostics::info("relay_receive", &format!("completeMessages={received_messages} lastMessageAgeMs={} ready={ready}",last_message.elapsed().as_millis()));
                        let snapshot = status.lock().unwrap();
                        diagnostics::info("game_relay_summary", &format!("role={} transport={} phase={} peers={} localTcpConnected={} activeGameStreams={} proxyPort={} advertisementCount={} localToRelayBytesWindow={} relayToLocalBytesWindow={} gameIdentity={:?}", snapshot.role, snapshot.transport, snapshot.phase, snapshot.peers, if host { !host_streams.is_empty() } else { tcp.is_some() }, host_streams.len().max(usize::from(tcp.is_some())), proxy_port, snapshot.advertisements, snapshot.sent_bytes.saturating_sub(previous_sent_bytes), snapshot.received_bytes.saturating_sub(previous_received_bytes), if host { host_game_identity } else { guest_game_identity }));
                        previous_sent_bytes = snapshot.sent_bytes;
                        previous_received_bytes = snapshot.received_bytes;
                        drop(snapshot);
                        last_relay_summary = Instant::now();
                    }
                    if !ready { continue; }
                    if host {
                        if host_streams.is_empty() && host_port.is_some_and(|(_,seen): (GameInfo,Instant)| seen.elapsed()>Duration::from_secs(6)) {
                            if let Some((info, _)) = host_port {
                                diagnostics::info("game_advertisement", &format!("event=host_advertisement_expired hostCounter={} entryKey={} port={}", info.host_counter, info.entry_key, info.port));
                            }
                            host_port = None;
                            update(&status,"waiting","本机对局广播已停止，等待重新建图");
                        }
                        udp.send_to(&search, "127.0.0.1:6112").await.map_err(|e| e.to_string())?;
                    } else if let Some((packet, seen)) = &advertisement {
                        if seen.elapsed() < Duration::from_secs(6) {
                            udp.send_to(packet, "127.0.0.1:6112").await.map_err(|e| e.to_string())?;
                        } else {
                            if let Some(info) = game_info(packet) {
                                diagnostics::info("game_advertisement", &format!("event=guest_advertisement_expired hostCounter={} entryKey={} advertisedPort={} proxyPort={proxy_port}", info.host_counter, info.entry_key, info.port));
                            }
                            let mut remove = vec![0xf7,0x33,8,0]; remove.extend(&packet[12..16]);
                            let _ = udp.send_to(&remove, "127.0.0.1:6112").await;
                            advertisement = None;
                            if tcp.is_none() { update(&status,"waiting","对局广播已过期，等待房主创建局域网游戏"); }
                        }
                    }
                },
                packet = udp.recv_from(&mut udp_buf), if host && ready => {
                    let (len, addr) = match packet {
                        Ok(value) => value,
                        // Windows reports ICMP port-unreachable while Warcraft is not open yet.
                        Err(e) if e.kind()==std::io::ErrorKind::ConnectionReset || e.raw_os_error()==Some(10054) => continue,
                        Err(e) => return Err(e.to_string()),
                    };
                    if !addr.ip().is_loopback() || addr.port()!=6112 { continue; }
                    let p = &udp_buf[..len];
                    if let Some(info) = game_info(p) {
                        host_port = Some((info, Instant::now()));
                        status.lock().unwrap().advertisements += 1;
                        host_advertisement_count += 1;
                        if host_game_identity != Some(info) {
                            diagnostics::info("game_advertisement", &format!("event=host_game_info identity_changed=true hostCounter={} entryKey={} advertisedPort={} packetBytes={len}", info.host_counter, info.entry_key, info.port));
                            host_game_identity = Some(info);
                        }
                        if last_advertisement_summary.elapsed() >= Duration::from_secs(15) {
                            diagnostics::info("game_advertisement", &format!("event=host_broadcast_summary packetsInWindow={host_advertisement_count} lastHostCounter={} lastEntryKey={} lastPort={}", info.host_counter, info.entry_key, info.port));
                            host_advertisement_count = 0;
                            last_advertisement_summary = Instant::now();
                        }
                        if host_streams.is_empty() { update(&status,"discovered","已发现本机对局，等待好友在游戏内加入"); }
                        send(&mut sink, Message::Text(serde_json::json!({"type":"advertisement","packet":p}).to_string().into())).await?;
                    }
                },
                accepted = listener.accept(), if ready && !host => {
                    let (socket, _) = accepted.map_err(|e|e.to_string())?;
                    if tcp.is_some() || advertisement.is_none() {
                        diagnostics::info("game_tcp", &format!("event=guest_proxy_rejected alreadyConnected={} hasAdvertisement={} peerAddr={:?}", tcp.is_some(), advertisement.is_some(), socket.peer_addr().ok()));
                        drop(socket); continue;
                    }
                    status.lock().unwrap().game_started = true;
                    socket.set_nodelay(true).map_err(|e|e.to_string())?;
                    stream_id = stream_id.wrapping_add(1).max(1);
                    diagnostics::info("game_tcp", &format!("event=guest_proxy_accepted streamId={stream_id} localAddr={:?} peerAddr={:?} gameIdentity={:?}", socket.local_addr().ok(), socket.peer_addr().ok(), guest_game_identity));
                    send(&mut sink, frame(1,stream_id,&[])).await?;
                    tcp = Some(socket); guest_stream_ready = false; update(&status,"forwarding","正在分配房间游戏通道");
                },
                read = async { match tcp.as_mut() { Some(s) => s.read(&mut tcp_buf).await, None => std::future::pending().await } }, if !host && guest_stream_ready => {
                    match read {
                        Ok(0) => { diagnostics::info("game_tcp", &format!("event=local_game_eof streamId={stream_id} direction=local_to_relay")); tcp = None; send(&mut sink, frame(3,stream_id,&[])).await?; update(&status,"waiting","游戏连接已结束，等待重新加入"); },
                        Ok(n) => {
                            send(&mut sink, frame(2,stream_id,&tcp_buf[..n])).await?;
                            status.lock().unwrap().sent_bytes += n as u64;
                        },
                        Err(error) => { diagnostics::error("game_tcp", &format!("event=local_game_read_failed streamId={stream_id} error={error}")); tcp = None; send(&mut sink, frame(3,stream_id,&[])).await?; update(&status,"waiting","读取本机游戏连接失败"); }
                    }
                },
                event = host_event_rx.recv(), if host => {
                    match event {
                        Some(HostSocketEvent::Data(id, bytes)) => {
                            if host_streams.contains_key(&id) {
                                send(&mut sink, frame(2,id,&bytes)).await?;
                                status.lock().unwrap().sent_bytes += bytes.len() as u64;
                            }
                        },
                        Some(HostSocketEvent::Closed(id, reason)) => {
                            if host_streams.remove(&id).is_some() {
                                diagnostics::info("game_tcp", &format!("event=host_stream_closed streamId={id} reason={reason}"));
                                send(&mut sink, frame(3,id,&[])).await?;
                                update(&status, if host_streams.is_empty() { "waiting" } else { "forwarding" }, if host_streams.is_empty() { "游戏连接已结束，等待好友加入" } else { "部分玩家已连接游戏" });
                            }
                        },
                        None => return Err("游戏 TCP 工作通道已关闭".into()),
                    }
                },
                incoming = source.next() => {
                    let message = match incoming {
                        None => { transport_failed = true; diagnostics::error("relay_transport", "event=relay_stream_ended direction=server_to_client"); return Err("中转连接已断开".into()); },
                        Some(Err(error)) => { transport_failed = true; diagnostics::error("relay_transport", &format!("event=relay_stream_read_failed direction=server_to_client error={error}")); return Err(error); },
                        Some(Ok(message)) => message,
                    };
                    last_message = Instant::now();
                    received_messages += 1;
                    match message {
                        Message::Ping(p) => {
                            let started = Instant::now();
                            let ping_id = p.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
                            send(&mut sink, Message::Pong(p)).await.map_err(|error| { transport_failed = true; error })?;
                            let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
                            let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                            let (summary, slow) = {
                                let mut state = status.lock().unwrap();
                                state.client_ping_samples.push(ClientPingSample { at, ping_id: ping_id.clone(), processing_ms });
                                if state.client_ping_samples.len() > 60 { state.client_ping_samples.remove(0); }
                                let recent: Vec<_> = state.client_ping_samples.iter().filter(|sample| at.saturating_sub(sample.at) <= 30000).collect();
                                let mut sorted: Vec<f64> = recent.iter().map(|sample| sample.processing_ms).collect();
                                sorted.sort_by(f64::total_cmp);
                                let report = if last_ping_summary.elapsed() >= Duration::from_secs(30) {
                                    last_ping_summary = Instant::now();
                                    let median = if sorted.is_empty() { 0.0 } else { sorted[sorted.len() / 2] };
                                    let max = recent.iter().max_by(|a, b| a.processing_ms.total_cmp(&b.processing_ms));
                                    Some(format!("windowSamples={} medianMs={median:.3} maxMs={:.3} maxPingId={}", recent.len(), max.map_or(0.0, |sample| sample.processing_ms), max.map_or("none", |sample| sample.ping_id.as_str())))
                                } else { None };
                                (report, processing_ms >= 5.0)
                            };
                            if let Some(summary) = summary { diagnostics::info("relay_ping", &summary); }
                            if slow { diagnostics::info("relay_ping_slow", &format!("pingId={ping_id}; processingMs={processing_ms:.3}")); }
                        },
                        Message::Pong(_) => {},
                        Message::Close(reason) => break Err(format!("中转连接已关闭：{}",reason.map(|r|r.reason.to_string()).unwrap_or_default())),
                        Message::Text(text) => {
                            let v: serde_json::Value = serde_json::from_str(&text).map_err(|e|e.to_string())?;
                            match v["type"].as_str() {
                                Some("ping") => {
                                    if let Some(ping_id) = v["pingId"].as_str() {
                                        let started = Instant::now();
                                        send(&mut sink, Message::Text(serde_json::json!({"type":"pong","pingId":ping_id}).to_string().into())).await.map_err(|error| { transport_failed = true; error })?;
                                        let processing_ms = started.elapsed().as_secs_f64() * 1000.0;
                                        let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                        let (summary, slow) = {
                                            let mut state = status.lock().unwrap();
                                            state.client_ping_samples.push(ClientPingSample { at, ping_id: ping_id.to_string(), processing_ms });
                                            if state.client_ping_samples.len() > 60 { state.client_ping_samples.remove(0); }
                                            let recent: Vec<_> = state.client_ping_samples.iter().filter(|sample| at.saturating_sub(sample.at) <= 30000).collect();
                                            let mut sorted: Vec<f64> = recent.iter().map(|sample| sample.processing_ms).collect();
                                            sorted.sort_by(f64::total_cmp);
                                            let report = if last_ping_summary.elapsed() >= Duration::from_secs(30) {
                                                last_ping_summary = Instant::now();
                                                let median = if sorted.is_empty() { 0.0 } else { sorted[sorted.len() / 2] };
                                                let max = recent.iter().max_by(|a, b| a.processing_ms.total_cmp(&b.processing_ms));
                                                Some(format!("windowSamples={} medianMs={median:.3} maxMs={:.3} maxPingId={}", recent.len(), max.map_or(0.0, |sample| sample.processing_ms), max.map_or("none", |sample| sample.ping_id.as_str())))
                                            } else { None };
                                            (report, processing_ms >= 5.0)
                                        };
                                        if let Some(summary) = summary { diagnostics::info("relay_ping", &summary); }
                                        if slow { diagnostics::info("relay_ping_slow", &format!("pingId={ping_id}; processingMs={processing_ms:.3}")); }
                                    }
                                },
                                Some("ready") => {
                                    host = v["role"]=="host"; ready = true;
                                    status.lock().unwrap().role = if host {"host"} else {"guest"}.into();
                                    diagnostics::info("relay", &format!("server marked relay ready; role={}", if host {"host"} else {"guest"}));
                                    update(&status,"waiting",if host {"中转已连接，请在魔兽局域网中创建对局"} else {"中转已连接，等待房主的局域网对局"});
                                },
                                Some("peers") => status.lock().unwrap().peers = v["count"].as_u64().unwrap_or(0) as usize,
                                Some("network") => {
                                    if let Ok(peers) = serde_json::from_value::<Vec<PeerNetwork>>(v["peers"].clone()) {
                                        status.lock().unwrap().peer_network = peers;
                                    }
                                },
                                Some("advertisement") if ready && !host => {
                                    let mut p: Vec<u8> = serde_json::from_value(v["packet"].clone()).map_err(|e|e.to_string())?;
                                    let Some(info) = game_info(&p) else {
                                        diagnostics::info("game_advertisement", "event=guest_advertisement_rejected reason=invalid_game_info");
                                        continue;
                                    };
                                    guest_advertisement_count += 1;
                                    if guest_game_identity != Some(info) {
                                        // The cached advertisement can expire before a new game is
                                        // announced. Keep the last published identity separately so
                                        // the old Warcraft LAN-list entry is still explicitly removed.
                                        if let Some(previous) = guest_game_identity {
                                            let mut remove = vec![0xf7,0x33,8,0]; remove.extend(&previous.host_counter.to_le_bytes());
                                            match udp.send_to(&remove,"127.0.0.1:6112").await {
                                                Ok(sent) => diagnostics::info("game_advertisement", &format!("event=guest_removed_previous reason=identity_replaced hostCounter={} entryKey={} port={} packetBytes={sent}", previous.host_counter, previous.entry_key, previous.port)),
                                                Err(error) => diagnostics::error("game_advertisement", &format!("event=guest_remove_previous_failed reason=identity_replaced hostCounter={} entryKey={} port={} error={error}", previous.host_counter, previous.entry_key, previous.port)),
                                            }
                                        }
                                        diagnostics::info("game_advertisement", &format!("event=guest_game_info identity_changed=true hostCounter={} entryKey={} advertisedPort={} proxyPort={} packetBytes={}", info.host_counter, info.entry_key, info.port, proxy_port, p.len()));
                                        guest_game_identity = Some(info);
                                    }
                                    let len = p.len(); p[len-2..].copy_from_slice(&proxy_port.to_le_bytes());
                                    udp.send_to(&p,"127.0.0.1:6112").await.map_err(|e|e.to_string())?;
                                    advertisement = Some((p,Instant::now())); status.lock().unwrap().advertisements += 1;
                                    if last_advertisement_summary.elapsed() >= Duration::from_secs(15) {
                                        diagnostics::info("game_advertisement", &format!("event=guest_broadcast_summary packetsInWindow={guest_advertisement_count} lastHostCounter={} lastEntryKey={} advertisedPort={} proxyPort={proxy_port}", info.host_counter, info.entry_key, info.port));
                                        guest_advertisement_count = 0;
                                        last_advertisement_summary = Instant::now();
                                    }
                                    if tcp.is_none() { update(&status,"discovered","已向本机发布对局，请进入魔兽的局域网列表"); }
                                },
                                _ => (),
                            }
                        },
                        Message::Binary(p) => {
                            if p.len()<5 { break Err("无效的中转帧".into()); }
                            let id = u32::from_le_bytes(p[1..5].try_into().unwrap());
                            match p[0] {
                                4 if !host && p.len()==9 && tcp.is_some() && id==stream_id => {
                                    let assigned_id = u32::from_le_bytes(p[5..9].try_into().unwrap());
                                    if assigned_id == 0 { break Err("服务端分配了无效的游戏流 ID".into()); }
                                    diagnostics::info("game_tcp", &format!("event=guest_stream_assigned localStreamId={id} roomStreamId={assigned_id}"));
                                    stream_id = assigned_id;
                                    guest_stream_ready = true;
                                    send(&mut sink, frame(4,assigned_id,&[])).await?;
                                    update(&status,"forwarding","本机游戏已接入代理；请在游戏内确认加入和开局");
                                },
                                1 if host && ready && host_streams.len() < 7 => {
                                    let fresh = host_port.filter(|(_,t)|t.elapsed()<Duration::from_secs(6));
                                    if let Some((info,seen)) = fresh {
                                        diagnostics::info("game_tcp", &format!("event=host_connect_attempt streamId={id} target=127.0.0.1:{} hostCounter={} entryKey={} advertisementAgeMs={}", info.port, info.host_counter, info.entry_key, seen.elapsed().as_millis()));
                                        let connect_started = Instant::now();
                                        match tokio::time::timeout(Duration::from_secs(3),TcpStream::connect((std::net::Ipv4Addr::LOCALHOST,info.port))).await {
                                            Ok(Ok(socket)) => { status.lock().unwrap().game_started = true; let _ = socket.set_nodelay(true); diagnostics::info("game_tcp", &format!("event=host_connected streamId={id} target=127.0.0.1:{} elapsedMs={} localAddr={:?} activeStreamsBefore={}", info.port, connect_started.elapsed().as_millis(), socket.local_addr().ok(), host_streams.len())); let (command_tx, command_rx) = mpsc::channel(32); spawn_host_socket(socket,id,command_rx,host_event_tx.clone()); host_streams.insert(id,command_tx); update(&status,"forwarding","游戏 TCP 已连接；等待其他玩家加入"); },
                                            Ok(Err(error)) => { diagnostics::error("game_tcp", &format!("event=host_connect_failed streamId={id} target=127.0.0.1:{} elapsedMs={} error={error}", info.port, connect_started.elapsed().as_millis())); send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","无法连接本机游戏端口，请检查房主是否仍在建房"); },
                                            Err(_) => { diagnostics::error("game_tcp", &format!("event=host_connect_timeout streamId={id} target=127.0.0.1:{} timeoutMs=3000", info.port)); send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","连接本机游戏端口超时，请检查房主是否仍在建房"); }
                                        }
                                    } else { diagnostics::error("game_tcp", &format!("event=host_connect_rejected streamId={id} reason=no_fresh_advertisement")); send(&mut sink, frame(3,id,&[])).await?; }
                                },
                                1 if host && ready => { diagnostics::error("game_tcp", &format!("event=host_connect_rejected streamId={id} reason=room_stream_limit activeStreams={}", host_streams.len())); send(&mut sink, frame(3,id,&[])).await?; },
                                2 if host => {
                                    if let Some(command) = host_streams.get(&id) {
                                        if command.send(HostSocketCommand::Write(p[5..].to_vec())).await.is_ok() { status.lock().unwrap().received_bytes += (p.len()-5) as u64; }
                                        else { diagnostics::error("game_tcp", &format!("event=host_stream_write_queue_failed streamId={id} payloadBytes={}",p.len()-5)); }
                                    }
                                },
                                3 if host => {
                                    if let Some(command) = host_streams.remove(&id) { let _ = command.send(HostSocketCommand::Close).await; diagnostics::info("game_tcp", &format!("event=host_stream_closed_by_peer streamId={id} activeStreams={}",host_streams.len())); }
                                    update(&status, if host_streams.is_empty() { "waiting" } else { "forwarding" }, if host_streams.is_empty() { "游戏连接已结束，等待好友加入" } else { "部分玩家已连接游戏" });
                                },
                                2 if !host && id==stream_id => if let Some(socket) = tcp.as_mut() {
                                    match tokio::time::timeout(Duration::from_secs(5),socket.write_all(&p[5..])).await {
                                        Ok(Ok(())) => status.lock().unwrap().received_bytes += (p.len()-5) as u64,
                                        Ok(Err(error)) => { diagnostics::error("game_tcp", &format!("event=local_game_write_failed streamId={id} payloadBytes={} error={error}", p.len()-5)); tcp = None; guest_stream_ready=false; send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","本机游戏连接写入失败"); }
                                        Err(_) => { diagnostics::error("game_tcp", &format!("event=local_game_write_timeout streamId={id} payloadBytes={} timeoutMs=5000", p.len()-5)); tcp = None; guest_stream_ready=false; send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","本机游戏连接写入超时"); }
                                    }
                                },
                                3 if !host && id==stream_id => { diagnostics::info("game_tcp", &format!("event=peer_closed_stream streamId={id} direction=peer_to_local")); tcp=None; guest_stream_ready=false; update(&status,"waiting","游戏连接已关闭，等待重新加入"); },
                                _ => (),
                            }
                        },
                        _ => (),
                    }
                }
            }
        }
    }.await;
    {
        let mut state = status.lock().unwrap();
        state.fallback_eligible = transport_name == "quic" && transport_failed && !state.game_started;
        diagnostics::info("relay_end", &format!("roomId={} transport={transport_name} gameStarted={} fallbackEligible={} completeMessages={received_messages} lastMessageAgeMs={} result={result:?}", state.room_id, state.game_started, state.fallback_eligible, last_message.elapsed().as_millis()));
    }
    if let Some(session) = &quic_session { session.log("relay_end"); }
    if let Some((p, _)) = advertisement {
        let mut remove = vec![0xf7, 0x33, 8, 0];
        remove.extend(&p[12..16]);
        let _ = udp.send_to(&remove, "127.0.0.1:6112").await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.close()).await;
    result
}
