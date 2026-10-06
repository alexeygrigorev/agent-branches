# Startup Enrolled Bus Transport & ReadAck Receipt

**Task ID**: t-bus-startup-c2818
**Worker Identity**: hetzner-rmthz/agent-branches/branches-startup-worker/-/t-bus-startup-c2818
**Worker Identity ID**: 4e4f2e84-212a-4728-ac07-c1faf67eef51
**Worker Credentials**: `.local/bus/worker-t-bus-startup-c2818.cred.json` (0600)
**Worker Result Envelope ID**: `41a1d9c1-d6d8-4aa1-95ce-31be1d88958b`
**Coordinator Identity ID**: a889cba5-bb9b-4f19-a509-df0efe64d248
**Coordinator ReadAck Time**: `2026-10-06T11:17:49Z`
**Coordinator task_ack Envelope ID**: `36c38492-9185-47d9-9d7b-982e40d03360`
**Worker Consumption Verdict**: `STARTUP_ENROLLMENT_AND_TESTS_VERIFIED`

## Handshake Summary
1. **Model Result Envelope Ingestion**:
   - Coordinator ingested `task_result` envelope `41a1d9c1-d6d8-4aa1-95ce-31be1d88958b` from startup-enrolled worker.
   - Verified schema compliance against pinned bus envelope schema (`12f9bde`).
2. **Coordinator ReadAck**:
   - Coordinator emitted durable `ReadAck` for `41a1d9c1-d6d8-4aa1-95ce-31be1d88958b` with state `recipient_read_ack`.
3. **Coordinator task_ack Dispatch**:
   - Dispatched authenticated `task_ack` envelope `36c38492-9185-47d9-9d7b-982e40d03360` correlated to `41a1d9c1-d6d8-4aa1-95ce-31be1d88958b`.
4. **Worker ACK Consumption & Cursor Advancement**:
   - Worker reloaded from 0600 credentials file.
   - `await_task_ack` matched `ack_for: 41a1d9c1-d6d8-4aa1-95ce-31be1d88958b`, emitted worker ReadAck, and advanced durable cursor.
   - Verified unread message count is 0 (zero duplicate re-delivery).

## Safety & Isolation
- Scope in `cloudflare-agent-git`: strictly `none` (zero modifications).
- All changes confined to `agent-branches`.
