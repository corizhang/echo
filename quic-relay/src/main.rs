use std::{env, error::Error, fs::File, io::BufReader, net::SocketAddr, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use quinn::{Endpoint, ServerConfig};
use tokio::sync::Semaphore;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_FRAME: usize = 65_536;

fn server_config(cert_path: &str, key_path: &str) -> Result<ServerConfig, Box<dyn Error>> {
    let mut cert_reader = BufReader::new(File::open(cert_path)?);
    let certs = rustls_pemfile::certs(&mut cert_reader).collect::<Result<Vec<_>, _>>()?;
    let mut key_reader = BufReader::new(File::open(key_path)?);
    let key = rustls_pemfile::private_key(&mut key_reader)?.ok_or("QUIC private key not found")?;
    Ok(ServerConfig::with_single_cert(certs, key)?)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let bind: SocketAddr = env::var("QUIC_BIND").unwrap_or_else(|_| "0.0.0.0:40000".into()).parse()?;
    let api_ws = env::var("ECHO_API_WS_URL").unwrap_or_else(|_| "ws://api:3000/api/v1/game-relay".into());
    let cert = env::var("QUIC_CERT_FILE").unwrap_or_else(|_| "/run/certs/echo.crt".into());
    let key = env::var("QUIC_KEY_FILE").unwrap_or_else(|_| "/run/certs/echo.key".into());
    let mut config = server_config(&cert, &key)?;
    config.max_incoming(256);
    let endpoint = Endpoint::server(config, bind)?;
    let sessions = Arc::new(Semaphore::new(64));
    eprintln!("QUIC game relay listening on {bind}");
    while let Some(incoming) = endpoint.accept().await {
        let Ok(permit) = sessions.clone().try_acquire_owned() else {
            drop(incoming);
            eprintln!("QUIC relay rejected connection: session limit reached");
            continue;
        };
        let api_ws = api_ws.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = handle(incoming, api_ws).await {
                eprintln!("QUIC relay session ended: {error}");
            }
        });
    }
    Ok(())
}

async fn handle(incoming: quinn::Incoming, api_ws: String) -> Result<(), Box<dyn Error + Send + Sync>> {
    let connection = tokio::time::timeout(Duration::from_secs(8), incoming).await??;
    let (mut send, mut recv) = tokio::time::timeout(Duration::from_secs(5), connection.accept_bi()).await??;
    let auth = read_frame(&mut recv).await?;
    if auth.0 != 1 || auth.1.len() > 256 { return Err("first QUIC frame must be a small text auth message".into()); }
    let auth_text = String::from_utf8(auth.1)?;
    if !auth_text.contains("\"ticket\"") { return Err("missing relay ticket".into()); }

    // The API remains the source of truth for one-time tickets and room membership.
    // This adapter only changes the network carrier from WSS/TCP to QUIC/UDP.
    let (ws, _) = tokio::time::timeout(Duration::from_secs(8), connect_async(&api_ws)).await??;
    let (mut ws_sink, mut ws_stream) = ws.split();
    ws_sink.send(Message::Text(auth_text.into())).await?;

    loop {
        tokio::select! {
            incoming = ws_stream.next() => {
                match incoming {
                    Some(Ok(message)) => {
                        if let Some((kind, payload)) = encode_ws(message) {
                            write_frame(&mut send, kind, &payload).await?;
                        } else { continue; }
                    }
                    Some(Err(error)) => return Err(error.into()),
                    None => return Ok(()),
                }
            }
            incoming = read_frame(&mut recv) => {
                let (kind, payload) = incoming?;
                let message = decode_ws(kind, payload)?;
                if matches!(message, Message::Close(_)) { let _ = ws_sink.send(message).await; return Ok(()); }
                ws_sink.send(message).await?;
            }
            _ = connection.closed() => return Ok(()),
        }
    }
}

fn encode_ws(message: Message) -> Option<(u8, Vec<u8>)> {
    match message {
        Message::Text(value) => Some((1, value.as_bytes().to_vec())),
        Message::Binary(value) => Some((2, value.to_vec())),
        Message::Ping(value) => Some((3, value.to_vec())),
        Message::Pong(value) => Some((4, value.to_vec())),
        Message::Close(value) => Some((5, value.map(|v| v.reason.to_string().into_bytes()).unwrap_or_default())),
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

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(u8, Vec<u8>), Box<dyn Error + Send + Sync>> {
    let length = reader.read_u32().await? as usize;
    if length == 0 || length > MAX_FRAME { return Err("invalid QUIC frame length".into()); }
    let mut frame = vec![0; length];
    reader.read_exact(&mut frame).await?;
    let kind = frame.remove(0);
    Ok((kind, frame))
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, kind: u8, payload: &[u8]) -> Result<(), Box<dyn Error + Send + Sync>> {
    if payload.len() + 1 > MAX_FRAME { return Err("QUIC frame too large".into()); }
    writer.write_u32((payload.len() + 1) as u32).await?;
    writer.write_u8(kind).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}
