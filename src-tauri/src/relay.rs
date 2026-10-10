use std::{sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use futures_util::{Sink, SinkExt, StreamExt};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::{TcpListener, TcpStream, UdpSocket}, sync::oneshot};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use crate::diagnostics;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PeerNetwork {
    role: String,
    rtt_ms: Option<u64>,
    jitter_ms: Option<u64>,
    missed_pongs: u64,
    #[serde(default)]
    rtt_history: Vec<NetworkSample>,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="camelCase")]
pub struct NetworkSample {
    at: u64,
    rtt_ms: u64,
    ping_id: String,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct ClientPingSample {
    at: u64,
    ping_id: String,
    processing_ms: f64,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct RelayStatus {
    room_id: String, phase: String, role: String, detail: String,
    peers: usize, advertisements: u64, sent_bytes: u64, received_bytes: u64, local_port: u16,
    peer_network: Vec<PeerNetwork>,
    client_ping_samples: Vec<ClientPingSample>,
}
impl Default for RelayStatus {
    fn default() -> Self { Self { room_id: String::new(), phase: "idle".into(), role: String::new(), detail: "尚未开启联机".into(), peers: 0, advertisements: 0, sent_bytes: 0, received_bytes: 0, local_port: 0, peer_network: Vec::new(), client_ping_samples: Vec::new() } }
}
#[derive(Default)]
pub struct Relay {
    status: Arc<Mutex<RelayStatus>>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
fn update(s: &Arc<Mutex<RelayStatus>>, phase: &str, detail: &str) {
    let mut state = s.lock().unwrap(); state.phase = phase.into(); state.detail = detail.into();
}
#[tauri::command]
pub fn relay_status(state: tauri::State<Mutex<Relay>>) -> RelayStatus { state.lock().unwrap().status.lock().unwrap().clone() }
#[tauri::command]
pub fn start_relay(state: tauri::State<Mutex<Relay>>, room_id: String, ticket: String) -> Result<(), String> {
    diagnostics::info("start_relay", &format!("command received; room_id={room_id}"));
    if ticket.len() > 128 || ticket.len() < 32 || room_id.len() > 100 {
        diagnostics::error("start_relay", "rejected invalid room credentials");
        return Err("无效的房间凭据".into());
    }
    let mut relay = state.lock().unwrap();
    if relay.task.as_ref().is_some_and(|t| !t.inner().is_finished()) {
        diagnostics::error("start_relay", "rejected because another relay task is running");
        return Err("请先断开当前联机通道".into());
    }
    let status = Arc::new(Mutex::new(RelayStatus { room_id, phase: "connecting".into(), detail: "正在连接中转服务".into(), ..Default::default() }));
    let (tx, rx) = oneshot::channel(); relay.stop = Some(tx); relay.status = status.clone();
    relay.task = Some(tauri::async_runtime::spawn(async move {
        match run(status.clone(), ticket, rx).await {
            Ok(()) => { diagnostics::info("relay_task", "relay stopped normally"); update(&status, "idle", "联机通道已关闭"); },
            Err(error) => { diagnostics::error("relay_task", &error); update(&status, "error", &error); },
        }
    }));
    diagnostics::info("start_relay", "relay task spawned");
    Ok(())
}
#[tauri::command]
pub fn stop_relay(state: tauri::State<Mutex<Relay>>) { if let Some(stop) = state.lock().unwrap().stop.take() { let _ = stop.send(()); } }

async fn send<S>(sink: &mut S, message: Message) -> Result<(), String>
where S: Sink<Message> + Unpin, S::Error: std::fmt::Display {
    tokio::time::timeout(Duration::from_secs(5), sink.send(message)).await
        .map_err(|_| "中转写入超时，请重新连接".to_string())?.map_err(|e|e.to_string())
}
fn frame(kind: u8, id: u32, bytes: &[u8]) -> Message {
    let mut v = Vec::with_capacity(bytes.len()+5); v.push(kind); v.extend(id.to_le_bytes()); v.extend(bytes); Message::Binary(v.into())
}
// W3GS_GAMEINFO has two variable strings followed by a fixed 22-byte tail.
fn game_info(p: &[u8]) -> Option<u16> {
    if p.len() < 44 || p.len() > 2048 || p[0..2] != [0xf7,0x30] || u16::from_le_bytes([p[2],p[3]]) as usize != p.len() || p[4..8] != *b"PX3W" || u32::from_le_bytes(p[8..12].try_into().ok()?) != 24 { return None; }
    let name_end = p[20..].iter().position(|b| *b==0)? + 20;
    if *p.get(name_end+1)? != 0 { return None; }
    let stat_start = name_end + 2;
    let stat_end = p.get(stat_start..)?.iter().position(|b| *b==0)? + stat_start;
    if p.len() != stat_end + 1 + 22 { return None; }
    let port = u16::from_le_bytes([p[p.len()-2],p[p.len()-1]]);
    // Only the classic Warcraft listen-port range, never arbitrary local services.
    (6112..=6119).contains(&port).then_some(port)
}
async fn run(status: Arc<Mutex<RelayStatus>>, ticket: String, mut stop: oneshot::Receiver<()>) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let base = option_env!("ECHO_SERVER_URL").unwrap_or("http://localhost:8080").trim_end_matches('/');
    let endpoint = format!("{}/api/v1/game-relay", base.replacen("http", "ws", 1));
    diagnostics::info("relay", &format!("connecting to {endpoint}"));
    let mut config = WebSocketConfig::default(); config.max_message_size = Some(65536); config.max_frame_size = Some(65536);
    let connect = tokio_tungstenite::connect_async_with_config(&endpoint, Some(config), true);
    let (ws, response) = tokio::select! {
        _ = &mut stop => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(10), connect) => result.map_err(|_| "中转连接超时")?.map_err(|e| format!("无法连接中转服务：{e}"))?,
    };
    diagnostics::info("relay", &format!("websocket handshake completed; http_status={}", response.status()));
    let (mut sink, mut source) = ws.split();
    send(&mut sink, Message::Text(serde_json::json!({"ticket":ticket}).to_string().into())).await?;
    let udp = UdpSocket::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let proxy_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    diagnostics::info("relay", &format!("local UDP and TCP proxy sockets bound; tcp_port={proxy_port}"));
    status.lock().unwrap().local_port = proxy_port;
    let mut host = false; let mut ready = false;
    let mut advertisement: Option<(Vec<u8>, Instant)> = None;
    let mut host_port = None;
    let mut tcp: Option<TcpStream> = None;
    let mut stream_id = 0u32;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut udp_buf = [0u8;2049]; let mut tcp_buf = [0u8;32768];
    let search = [0xf7,0x2f,16,0,b'P',b'X',b'3',b'W',24,0,0,0,0,0,0,0];
    let mut last_message = Instant::now();
    let mut last_ping_summary = Instant::now();
    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                _ = &mut stop => break Ok(()),
                _ = tick.tick() => {
                    if last_message.elapsed() > Duration::from_secs(35) { break Err("中转服务失去响应，请重新连接".into()); }
                    if !ready { continue; }
                    if host {
                        if tcp.is_none() && host_port.is_some_and(|(_,seen): (u16,Instant)| seen.elapsed()>Duration::from_secs(6)) {
                            host_port = None;
                            update(&status,"waiting","本机对局广播已停止，等待重新建图");
                        }
                        udp.send_to(&search, "127.0.0.1:6112").await.map_err(|e| e.to_string())?;
                    } else if let Some((packet, seen)) = &advertisement {
                        if seen.elapsed() < Duration::from_secs(6) {
                            udp.send_to(packet, "127.0.0.1:6112").await.map_err(|e| e.to_string())?;
                        } else {
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
                    if let Some(port) = game_info(p) {
                        host_port = Some((port, Instant::now()));
                        status.lock().unwrap().advertisements += 1;
                        if tcp.is_none() { update(&status,"discovered","已发现本机对局，等待好友在游戏内加入"); }
                        send(&mut sink, Message::Text(serde_json::json!({"type":"advertisement","packet":p}).to_string().into())).await?;
                    }
                },
                accepted = listener.accept(), if ready && !host => {
                    let (socket, _) = accepted.map_err(|e|e.to_string())?;
                    if tcp.is_some() || advertisement.is_none() { drop(socket); continue; }
                    socket.set_nodelay(true).map_err(|e|e.to_string())?;
                    stream_id = stream_id.wrapping_add(1).max(1);
                    send(&mut sink, frame(1,stream_id,&[])).await?;
                    tcp = Some(socket); update(&status,"forwarding","本机游戏已接入代理；请在游戏内确认加入和开局");
                },
                read = async { match tcp.as_mut() { Some(s) => s.read(&mut tcp_buf).await, None => std::future::pending().await } } => {
                    match read {
                        Ok(n) if n>0 => {
                            send(&mut sink, frame(2,stream_id,&tcp_buf[..n])).await?;
                            status.lock().unwrap().sent_bytes += n as u64;
                        },
                        _ => { tcp = None; send(&mut sink, frame(3,stream_id,&[])).await?; update(&status,"waiting","游戏连接已结束，等待重新加入"); }
                    }
                },
                incoming = source.next() => {
                    let message = incoming.ok_or("中转连接已断开")?.map_err(|e|e.to_string())?;
                    last_message = Instant::now();
                    match message {
                        Message::Ping(p) => {
                            let started = Instant::now();
                            let ping_id = p.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
                            send(&mut sink, Message::Pong(p)).await?;
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
                                    if game_info(&p).is_none() { continue; }
                                    let len = p.len(); p[len-2..].copy_from_slice(&proxy_port.to_le_bytes());
                                    udp.send_to(&p,"127.0.0.1:6112").await.map_err(|e|e.to_string())?;
                                    advertisement = Some((p,Instant::now())); status.lock().unwrap().advertisements += 1;
                                    if tcp.is_none() { update(&status,"discovered","已向本机发布对局，请进入魔兽的局域网列表"); }
                                },
                                _ => (),
                            }
                        },
                        Message::Binary(p) => {
                            if p.len()<5 { break Err("无效的中转帧".into()); }
                            let id = u32::from_le_bytes(p[1..5].try_into().unwrap());
                            match p[0] {
                                1 if host && ready && tcp.is_none() => {
                                    let fresh = host_port.filter(|(_,t)|t.elapsed()<Duration::from_secs(6));
                                    if let Some((port,_)) = fresh {
                                        match tokio::time::timeout(Duration::from_secs(3),TcpStream::connect((std::net::Ipv4Addr::LOCALHOST,port))).await {
                                            Ok(Ok(socket)) => { let _ = socket.set_nodelay(true); tcp = Some(socket); stream_id=id; update(&status,"forwarding","游戏 TCP 已连接；请在游戏内确认加入和开局"); },
                                            _ => { send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","无法连接本机游戏端口，请检查房主是否仍在建房"); }
                                        }
                                    } else { send(&mut sink, frame(3,id,&[])).await?; }
                                },
                                2 if id==stream_id => if let Some(socket) = tcp.as_mut() {
                                    match tokio::time::timeout(Duration::from_secs(5),socket.write_all(&p[5..])).await {
                                        Ok(Ok(())) => status.lock().unwrap().received_bytes += (p.len()-5) as u64,
                                        _ => { tcp = None; send(&mut sink, frame(3,id,&[])).await?; update(&status,"waiting","本机游戏连接写入失败"); }
                                    }
                                },
                                3 if id==stream_id => { tcp=None; update(&status,"waiting","游戏连接已关闭，等待重新加入"); },
                                _ => (),
                            }
                        },
                        _ => (),
                    }
                }
            }
        }
    }.await;
    if let Some((p,_)) = advertisement { let mut remove = vec![0xf7,0x33,8,0]; remove.extend(&p[12..16]); let _ = udp.send_to(&remove,"127.0.0.1:6112").await; }
    let _ = tokio::time::timeout(Duration::from_secs(1),sink.close()).await;
    result
}
