# WebSocket RFC6455 — Educational Implementation

[![RFC6455](https://img.shields.io/badge/WebSocket-RFC%206455-brightgreen)](https://datatracker.ietf.org/doc/html/rfc6455)

A custom, ground-up implementation of the [WebSocket Protocol (RFC 6455)](https://datatracker.ietf.org/doc/html/rfc6455). This repository explores how to establish and handle bi-directional communication between clients and servers using a single TCP connection.

## Table of Contents

- [Overview](#overview)
- [To Do](#to-do)
- [Test Suite](#test-suite)

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
- [x] **Ping/Pong Frames** — Implement heartbeat mechanisms for connection liveness.
- [x] **Opcode Handling** — Properly differentiate and handle control and non-control opcodes.

### ⏳ In Progress / Planned
- [ ] **Fragmentation Support** — Add support for fragmented messages.
- [ ] **UTF-8 Validation** — Ensure all text frames contain valid UTF-8 as required by the spec.
- [ ] **Connection Closure** — Handle connection teardown with appropriate status codes.
- [ ] **Router Implementation** — Design and implement a lightweight internal router to dispatch messages to appropriate handlers based on message type or path.
- [ ] **Client Compliance Testing** — Add test scenarios and validations to ensure the client-side implementation behaves correctly and adheres to RFC6455, including handshake logic, frame formatting, and connection management.

---

## Test Suite

This project uses the [Autobahn Test Suite](https://github.com/crossbario/autobahn-testsuite) to validate compliance with RFC 6455.

The tests are designed to rigorously evaluate this implementation against a broad set of edge cases and protocol requirements.

### 🧪 Running Tests

To run the test suite:

1. Navigate to the test directory:

   ```bash
   cd ./test/autobahn
   ```
   
2. Execute the test runner script:

   ```bash
   sh ./run-wstest.sh
   ```
