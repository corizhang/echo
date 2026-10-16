use std::{
    env,
    error::Error,
    fmt::Write as FmtWrite,
    fs::File,
    io::BufReader,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use quinn::{Endpoint, ServerConfig};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_FRAME: usize = 65_536;

fn json_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character <= '\u{1f}' => {
                let _ = write!(escaped, "\\u{:04x}", character as u32);
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

fn json_number(value: impl std::fmt::Display) -> String { value.to_string() }
fn json_bool(value: bool) -> String { value.to_string() }
fn json_option_number(value: Option<impl std::fmt::Display>) -> String {
    value.map(|value| value.to_string()).unwrap_or_else(|| "null".into())
}

fn log_event(level: &str, event: &str, fields: Vec<(&str, String)>) {
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let instance = env::var("ECHO_INSTANCE_ID")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("HOSTNAME").ok())
        .unwrap_or_else(|| "unknown".into());
    let mut line = format!(
        "{{\"timestamp_unix_ms\":{timestamp},\"schema_version\":1,\"level\":{},\"service\":\"game-quic-relay\",\"instance\":{},\"event\":{}",
        json_string(level), json_string(&instance), json_string(event)
    );
    for (key, value) in fields {
        let _ = write!(line, ",{}:{value}", json_string(key));
    }
    line.push('}');
    eprintln!("{line}");
}

fn server_config(cert_path: &str, key_path: &str) -> Result<ServerConfig, Box<dyn Error>> {
    let mut cert_reader = BufReader::new(File::open(cert_path)?);
    let certs = rustls_pemfile::certs(&mut cert_reader).collect::<Result<Vec<_>, _>>()?;
    let mut key_reader = BufReader::new(File::open(key_path)?);
    let key = rustls_pemfile::private_key(&mut key_reader)?.ok_or("QUIC private key not found")?;
    Ok(ServerConfig::with_single_cert(certs, key)?)
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        log_event("fatal", "quic_relay_start_failed", vec![("error", json_string(&format!("{error:#}")))]);
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let bind: SocketAddr = env::var("QUIC_BIND")
        .unwrap_or_else(|_| "0.0.0.0:40000".into())
        .parse()?;
    let api_ws =
        env::var("ECHO_API_WS_URL").unwrap_or_else(|_| "ws://api:3000/api/v1/game-relay".into());
    let cert = env::var("QUIC_CERT_FILE").unwrap_or_else(|_| "/run/certs/echo.crt".into());
    let key = env::var("QUIC_KEY_FILE").unwrap_or_else(|_| "/run/certs/echo.key".into());
    let mut config = server_config(&cert, &key)?;
    config.max_incoming(256);
    let mode = env::var("QUIC_TRANSPORT_MODE").unwrap_or_else(|_| "standard".into());
    if !["standard", "compat"].contains(&mode.as_str()) { return Err("QUIC_TRANSPORT_MODE must be standard or compat".into()); }
    let mut transport = quinn::TransportConfig::default();
    transport.keep_alive_interval(Some(Duration::from_secs(5)));
    if mode == "compat" { transport.initial_mtu(1200).min_mtu(1200).mtu_discovery_config(None); }
    config.transport_config(Arc::new(transport));
    log_event("info", "quic_transport_config", vec![
        ("mode", json_string(&mode)),
        ("keep_alive_seconds", json_number(5)),
        ("mtu_discovery", json_bool(mode != "compat")),
    ]);
    let endpoint = Endpoint::server(config, bind)?;
    let sessions = Arc::new(Semaphore::new(64));
    log_event("info", "quic_relay_listening", vec![("bind", json_string(&bind.to_string()))]);
    while let Some(incoming) = endpoint.accept().await {
        let Ok(permit) = sessions.clone().try_acquire_owned() else {
            drop(incoming);
            log_event("warn", "quic_connection_rejected", vec![("reason", json_string("session_limit_reached"))]);
            continue;
        };
        let api_ws = api_ws.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = handle(incoming, api_ws).await {
                log_event("error", "quic_session_error", vec![("error", json_string(&format!("{error:#}")))]);
            }
        });
    }
    Ok(())
}

struct SessionDiagnostics(quinn::Connection);
impl SessionDiagnostics {
    fn log(&self, event: &str) {
        log_event("info", "quic_connection_stats", vec![
            ("phase", json_string(event)),
            ("connection_id", json_string(&self.0.stable_id().to_string())),
            ("remote", json_string(&self.0.remote_address().to_string())),
            ("close_reason", json_string(&format!("{:?}", self.0.close_reason()))),
            ("stats_text", json_string(&format!("{:?}", self.0.stats()))),
        ]);
    }
}
impl Drop for SessionDiagnostics {
    fn drop(&mut self) { self.log("session_end"); self.0.close(0u32.into(), b"relay session ended"); }
}

async fn handle(
    incoming: quinn::Incoming,
    api_ws: String,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let connection = tokio::time::timeout(Duration::from_secs(8), incoming).await??;
    let diagnostics = SessionDiagnostics(connection.clone());
    diagnostics.log("handshake_complete");
    let remote = connection.remote_address();
    log_event("info", "quic_session_established", vec![("remote", json_string(&remote.to_string()))]);
    let (mut send, mut recv) =
        tokio::time::timeout(Duration::from_secs(5), connection.accept_bi()).await??;
    let auth = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut recv)).await??;
    if auth.0 != 1 || auth.1.len() > 256 {
        return Err(format!(
            "remote={remote} invalid auth frame kind={} bytes={}",
            auth.0,
            auth.1.len()
        )
        .into());
    }
    let auth_text = String::from_utf8(auth.1)?;
    if !auth_text.contains("\"ticket\"") {
        return Err(format!("remote={remote} missing relay ticket field").into());
    }

    // The API remains the source of truth for one-time tickets and room membership.
    // This adapter only changes the network carrier from WSS/TCP to QUIC/UDP.
    let (ws, response) =
        tokio::time::timeout(Duration::from_secs(8), connect_async(&api_ws)).await??;
    let (mut ws_sink, mut ws_stream) = ws.split();
    ws_sink.send(Message::Text(auth_text.into())).await?;
    log_event("info", "quic_auth_sent_to_api", vec![
        ("remote", json_string(&remote.to_string())),
        ("api_status", json_number(response.status().as_u16())),
    ]);

    // Keep one task as the sole owner of RecvStream reads. A read_frame future
    // cannot be cancelled safely after consuming a partial length/body; select!
    // cancellation used to lose those bytes and desynchronize subsequent frames.
    let (frame_tx, mut frame_rx) = mpsc::channel::<Result<(u8, Vec<u8>), String>>(128);
    let reader_remote = remote;
    let reader = tokio::spawn(async move {
        loop {
            let frame = match read_frame(&mut recv).await {
                Ok(frame) => Ok(frame),
                Err(error) => Err(format!(
                    "client_to_api QUIC frame read failed remote={reader_remote}: {error}"
                )),
            };
            let finished = frame.is_err();
            if frame_tx.send(frame).await.is_err() || finished {
                break;
            }
        }
        log_event("info", "quic_frame_reader_stopped", vec![("remote", json_string(&reader_remote.to_string()))]);
    });

    let started = Instant::now();
    let mut last_report = Instant::now();
    let mut last_client_frame: Option<Instant> = None;
    let mut last_api_frame: Option<Instant> = None;
    let mut quic_to_api_frames = 0u64;
    let mut api_to_quic_frames = 0u64;
    let mut quic_to_api_bytes = 0u64;
    let mut api_to_quic_bytes = 0u64;

    let result = loop {
        tokio::select! {
            incoming = ws_stream.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        last_api_frame = Some(Instant::now());
                        if let Some((kind, payload)) = encode_ws(message) {
                            api_to_quic_frames += 1;
                            api_to_quic_bytes += payload.len() as u64;
                            if kind == 2 && payload.len() >= 5 && matches!(payload[0], 1 | 3) {
                                log_event("debug", "quic_game_control", vec![
                                    ("direction", json_string("api_to_client")),
                                    ("kind", json_number(payload[0])),
                                    ("stream_id", json_number(u32::from_le_bytes(payload[1..5].try_into().unwrap()))),
                                    ("remote", json_string(&remote.to_string())),
                                ]);
                            }
                            if let Err(error) = write_frame(&mut send, kind, &payload).await {
                                break Err(error);
                            }
                        } else { continue; }
                    }
                    Some(Err(error)) => break Err(Box::new(error) as Box<dyn Error + Send + Sync>),
                    None => break Ok(()),
                }
            }
            incoming = frame_rx.recv() => {
                let (kind, payload) = match incoming {
                    Some(Ok(frame)) => frame,
                    Some(Err(error)) => break Err(error.into()),
                    None => break Err("QUIC frame reader stopped unexpectedly".into()),
                };
                last_client_frame = Some(Instant::now());
                quic_to_api_frames += 1;
                quic_to_api_bytes += payload.len() as u64;
                if kind == 2 && payload.len() >= 5 && matches!(payload[0], 1 | 3) {
                    log_event("debug", "quic_game_control", vec![
                        ("direction", json_string("client_to_api")),
                        ("kind", json_number(payload[0])),
                        ("stream_id", json_number(u32::from_le_bytes(payload[1..5].try_into().unwrap()))),
                        ("remote", json_string(&remote.to_string())),
                    ]);
                }
                let message = match decode_ws(kind, payload) {
                    Ok(message) => message,
                    Err(error) => break Err(error),
                };
                if matches!(message, Message::Close(_)) { let _ = ws_sink.send(message).await; break Ok(()); }
                if let Err(error) = ws_sink.send(message).await { break Err(Box::new(error) as Box<dyn Error + Send + Sync>); }
            }
            _ = tokio::time::sleep_until((last_report + Duration::from_secs(15)).into()) => {
                diagnostics.log("window");
                log_event("info", "quic_application_receive_window", vec![
                    ("remote", json_string(&remote.to_string())),
                    ("last_client_frame_age_ms", json_option_number(last_client_frame.map(|at| at.elapsed().as_millis()))),
                    ("last_api_frame_age_ms", json_option_number(last_api_frame.map(|at| at.elapsed().as_millis()))),
                ]);
                log_event("info", "quic_traffic_window", vec![
                    ("window_seconds", json_number(last_report.elapsed().as_secs())),
                    ("remote", json_string(&remote.to_string())),
                    ("client_to_api_frames", json_number(quic_to_api_frames)),
                    ("client_to_api_bytes", json_number(quic_to_api_bytes)),
                    ("api_to_client_frames", json_number(api_to_quic_frames)),
                    ("api_to_client_bytes", json_number(api_to_quic_bytes)),
                    ("total_seconds", json_number(started.elapsed().as_secs_f64())),
                ]);
                quic_to_api_frames = 0; api_to_quic_frames = 0; quic_to_api_bytes = 0; api_to_quic_bytes = 0;
                last_report = Instant::now();
            }
            error = connection.closed() => break Err(format!("QUIC connection closed remote={remote}: {error}").into()),
        }
    };
    reader.abort();
    log_event("info", "quic_session_closed", vec![
        ("remote", json_string(&remote.to_string())),
        ("elapsed_seconds", json_number(started.elapsed().as_secs_f64())),
        ("client_to_api_frames", json_number(quic_to_api_frames)),
        ("client_to_api_bytes", json_number(quic_to_api_bytes)),
        ("api_to_client_frames", json_number(api_to_quic_frames)),
        ("api_to_client_bytes", json_number(api_to_quic_bytes)),
        ("result", json_string(if result.is_ok() { "clean" } else { "error" })),
    ]);
    result
}

fn encode_ws(message: Message) -> Option<(u8, Vec<u8>)> {
    match message {
        Message::Text(value) => Some((1, value.as_bytes().to_vec())),
        Message::Binary(value) => Some((2, value.to_vec())),
        Message::Ping(value) => Some((3, value.to_vec())),
        Message::Pong(value) => Some((4, value.to_vec())),
        Message::Close(value) => Some((
            5,
            value
                .map(|v| v.reason.to_string().into_bytes())
                .unwrap_or_default(),
        )),
        Message::Frame(_) => None,
    }
}

fn decode_ws(kind: u8, payload: Vec<u8>) -> Result<Message, Box<dyn Error + Send + Sync>> {
    Ok(match kind {
        1 => Message::Text(String::from_utf8(payload)?.into()),
        2 => Message::Binary(payload.into()),
        3 => Message::Ping(payload.into()),
        4 => Message::Pong(payload.into()),
        5 => Message::Close(None),
        _ => return Err("invalid QUIC WebSocket frame type".into()),
    })
}

async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<(u8, Vec<u8>), Box<dyn Error + Send + Sync>> {
    let length = reader.read_u32().await? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("invalid QUIC frame length".into());
    }
    let mut frame = vec![0; length];
    reader.read_exact(&mut frame).await?;
    let kind = frame.remove(0);
    Ok((kind, frame))
}

async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    kind: u8,
    payload: &[u8],
) -> Result<(), Box<dyn Error + Send + Sync>> {
    if payload.len() + 1 > MAX_FRAME {
        return Err("QUIC frame too large".into());
    }
    writer.write_u32((payload.len() + 1) as u32).await?;
    writer.write_u8(kind).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}
