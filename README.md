# WebSocket RFC6455 — Educational Implementation

[![RFC6455](https://img.shields.io/badge/WebSocket-RFC%206455-brightgreen)](https://datatracker.ietf.org/doc/html/rfc6455)

A custom, ground-up implementation of the [WebSocket Protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455). This repository explores how to establish and handle bi-directional communication between clients and servers using a single TCP connection.

## Table of Contents

- [Overview](#overview)
- [To Do](#to-do)

---

## Overview

This project focuses on the essential components of WebSockets:

- **Handshake**: Using the `Upgrade` header to transition from HTTP/1.1 to WebSocket.
- **Framing**: Structuring data in a standard format for transmission.
- **Ping/Pong**: Verifying connection health and liveness.
- **Close**: Gracefully terminating connections with status codes.
- **Masking**: Ensuring security for client-to-server communication via XOR masking.

By taking a low-level approach, the implementation aims to offer a clear, instructive look into how RFC6455 operates under the hood.

---

## To Do

### ✔️ Completed
- [x] **Initial Handshake** — Implemented the opening handshake logic as per RFC 6455.
- [x] **Basic Framing** — Established the foundational structure for framing WebSocket messages.
- [x] **Masking Support** — Added masking and unmasking for client-sent payloads.
- [x] **Text Message Handling** — Supported text frames with payload lengths of 7-bit, 16-bit, and 64-bit.
- [x] **Binary Frame Support** — Implement binary message handling.

### ⏳ In Progress / Planned
- [ ] **Ping/Pong Frames** — Implement heartbeat mechanisms for connection liveness.
- [ ] **Opcode Handling** — Properly differentiate and handle control and non-control opcodes.
- [ ] **Fragmentation Support** — Add support for fragmented messages.
- [ ] **Fragmentation Mechanism** — Implement reassembly logic for fragmented frames.
- [ ] **Connection Closure** — Handle connection teardown with appropriate status codes.
