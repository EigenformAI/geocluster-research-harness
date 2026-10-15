# Owned-demo integration requirements

These requirements coordinate the application backend, runtime, and provider.

## Deployment and backend ordering

- Private seed staging and project storage must share a retained filesystem.
- The backend calls the active machine's root deletion endpoint under the project
  lifecycle lock, before committing logical deletion. It supplies the current
  runtime owner identity, which is distinct from the provider machine ID.
- The backend must await and validate the acknowledgement to record a confirmed
  local publication fence. A timeout, failed response, or mismatched target does
  not establish a fence.
- Approved deletion policy allows logical deletion and provider cleanup to
  continue after a bounded, unconfirmed drain. The backend records the
  unconfirmed fence durably. This fallback does not establish writer quiescence.
- Confirmed provider destruction is a separate execution boundary. Even a
  confirmed local admission fence does not establish a complete drain, remote
  persistence, or permission to destroy the volume.
- Replacement work requires backend-authorized ownership. A deleted assignment
  admits no replacement work.
- A map checkpoint acknowledgement does not complete initial readiness. The
  backend must observe the private bootstrap pointer and finalize `initialReadyAt`
  under its lifecycle checks before the original attempt deadline expires.
  Initialization and Stop must not restart that deadline.

## Operator authority

Retention release is a local operator action after backend initial completion.
The root public endpoint must not expose it to browsers. The private endpoint
requires the exact assignment and original map permit identities. A project
cookie does not grant this authority.
