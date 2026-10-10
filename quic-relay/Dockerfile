FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev build-base perl
WORKDIR /src
COPY Cargo.toml ./
COPY Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3.22
RUN addgroup -S -g 10001 echo && adduser -S -u 10001 -G echo echo
COPY --from=build /src/target/release/echo-game-quic-relay /usr/local/bin/echo-game-quic-relay
USER echo
EXPOSE 40000/udp
ENTRYPOINT ["/usr/local/bin/echo-game-quic-relay"]
