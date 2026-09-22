# RD data protocol 1 (development)

The numeric registry is `remote-desktop.v1.json`; generated JavaScript,
TypeScript, C++ and Kotlin constants share its 24-byte big-endian frame header.
This document specifies the additional JSON payloads used by the 8.0 clients.
The contract is not frozen for release yet. A successful build or protocol test
does not establish operational native media support.

All payloads below require the current connection epoch, valid monotonic lease,
peer proof and actual direct UDP path. No server payload forwarding is permitted.
Messages on different channels can arrive in either order; slow file I/O must
never block the control channel, revocation or the input watchdog.

## Input control and displays

| Message | JSON fields |
| --- | --- |
| CONTROL_REQUEST | `request_id` UUID, `requested_input_permissions` array |
| CONTROL_GRANTED | echo `request_id`, positive increasing `new_input_epoch` |
| INPUT_STATE | echo `request_id`, `generation` (input epoch), `keys`, `buttons`, `motion_sequence` |
| INPUT_SYNC_ACK | echo `request_id`, `input_epoch`, `layout_epoch` |
| RELEASE_ALL | `reason` (bounded non-sensitive enum/string) |
| DISPLAY_LAYOUT | increasing `layout_epoch`, `active_display` ID, 1–16 `displays` with unique `id` and `slot`, positive `width_px`, `height_px`, optional `name` |
| DISPLAY_SELECT | `display_id`, current `layout_epoch` |

A controller enables input only after the ACK for its current request and epochs.
Late grants/ACKs after release or a newer request are discarded and explicitly
released; they do not terminate the read-only video session. Layout changes first
release all input. Reliable button packets carry their own coordinates. Text
commits carry an independent UUID and final UTF-8, never intermediate IME state.

## Independent features

`FEATURE_REQUEST {permission, enabled}` asks the host to enable or disable exactly
one already-granted feature. `FEATURE_STATE {permission, enabled, error_code?}`
acknowledges actual backend state. A request cannot enlarge the signed scope.
Only audio.system, audio.microphone, clipboard.read/write and files.send/receive
use this feature switch. They default off and require host agreement.

Microphone capture is reserved to one controller session, including while an OS
permission prompt is pending. Stops invalidate pending capture callbacks, detach
the track and tell the host to clear its virtual-input buffer. Clipboard is bound
to one explicitly selected foreground session. Background transitions clear
pending text and disable the feature; late payloads do not reopen it.

## Text clipboard

`CLIPBOARD_OFFER {id, size, sha256, mime}` uses a fresh UUID, UTF-8 byte size ≤65536,
lowercase hexadecimal SHA256 and MIME `text/plain;charset=utf-8`.
`CLIPBOARD_ACCEPT {id}` permits chunks. Each binary chunk is UUID16 + uint64-BE
offset + UTF-8 bytes (up to 8192 bytes from browser). The declared total is exact;
invalid UTF-8, gaps, overflow and digest mismatches fail safely. After all bytes
are checked, `CLIPBOARD_ACK {id}` completes the operation; an empty clipboard
requires no chunks. Retain bounded recent IDs and last-content digest to suppress
echoes. Never automatically write an OS clipboard without required foreground
permission/user gesture. Clear buffers on stop, revoke, reconnect and logout.

## Selected files

| Message | Payload |
| --- | --- |
| FILE_OFFER | `{id, name, size}`; fresh UUID, basename, exact bytes |
| FILE_ACCEPT | `{id}` after the user selects a writable destination |
| FILE_CHUNK | UUID16 + uint64-BE offset + 1–16384 bytes |
| FILE_ACK (chunk) | `{id, offset}` after the receiver writes this chunk; offset is total bytes written |
| FILE_COMPLETE | `{id, size, sha256}` after the sender has received every chunk ACK |
| FILE_ACK (complete) | `{id, sha256}` only after exact size/digest verification and successful destination commit |
| FILE_CANCEL | `{id, reason}`; stop reads/writes and abort the temporary destination |

Maximum file size is 8 GiB, batch 32 GiB/64 files, with two active files and one
unacknowledged chunk per file. This application-level ACK bounds pending disk
writes independently of SCTP's network buffer. Completion ACKs cannot be confused
with chunk ACKs. Empty files use OFFER/ACCEPT/COMPLETE without chunks. Pending
offers and stalled ACKs have bounded timeouts. Filenames must not contain path
separators, controls, traversal or platform-reserved names. Files are never opened
automatically. Overwrite requires the destination selector's explicit consent.
Canceled IDs tolerate bounded late chunks/completion without killing other files
or the viewing session. A disconnected transfer requires a new offer and explicit
acceptance; no automatic replay. Cancellation during the destination's final
commit cannot claim that a file already written by the OS was removed.

## Signed authorization fixtures

`remote-authorization-vectors.json` contains public keys and fixed-time real
ES256/P1363 signed ticket, lease and host grant vectors. Join each `jws_parts`
array with `.` to recover a compact JWS. The private fixture keys are discarded
and none of these keys or claims are trusted in production.

Ticket and lease both bind `session_request_id` as well as session/epoch, owner,
endpoints, key thumbprints, grant/version, restore epoch and permissions. A
one-session grant's `one_session_request_id` must equal that signed request ID.
The negative vectors are correctly signed but fail their binding or validity
checks; signature verification alone must never make them acceptable.
