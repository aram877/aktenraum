# Spec Delta

## Purpose

How a member's browser session is created, recognised, kept alive, expired and revoked, how a member sees and ends their own sessions, and what long-lived connections do when their session ends.

## ADDED Requirements

### Requirement: A session is an opaque, server-side record
A successful login (password, or invite redemption) SHALL create a session record on the server and set a cookie that holds only a random, unguessable token. The server SHALL store only a one-way hash of the token. The cookie SHALL be `httpOnly` and `SameSite=Lax`; when the deployment is configured for HTTPS it SHALL also be `Secure` and use the `__Host-` name prefix. A request whose cookie does not match an active session SHALL be answered 401.

#### Scenario: login creates a session
- **WHEN** a member logs in with the correct password
- **THEN** the response sets a session cookie, and a session for that member exists on the server

#### Scenario: tampered or unknown cookie
- **WHEN** a request carries a session cookie whose token matches no session
- **THEN** it is answered 401

#### Scenario: token not recoverable from the database
- **WHEN** someone reads the stored session records
- **THEN** no stored value can be sent back as a working session cookie

#### Scenario: session cookies from before the upgrade
- **WHEN** a browser sends a session cookie issued before this change
- **THEN** it is answered 401 and the member logs in again once

### Requirement: Sessions expire after inactivity and after a maximum age
A session SHALL expire 7 days after its last use and in any case 30 days after it was created (both configurable). Using a session SHALL extend its inactivity expiry, but never beyond the maximum age. An expired session SHALL be answered 401.

#### Scenario: idle expiry
- **WHEN** a session has not been used for more than the inactivity period
- **THEN** the next request with it is answered 401

#### Scenario: use keeps it alive
- **WHEN** a member uses a session daily
- **THEN** it stays valid until the maximum age is reached, then answers 401

### Requirement: Ending a session takes effect on the server
Logging out SHALL revoke the current session on the server, so the same cookie no longer works anywhere. Changing the password SHALL revoke every session of the member. Removing a member from the household SHALL revoke every session of that member.

#### Scenario: logout
- **WHEN** a member logs out and the old cookie is sent again (e.g. copied before)
- **THEN** it is answered 401

#### Scenario: password change
- **WHEN** a member changes their password while signed in on two devices
- **THEN** both devices' sessions answer 401 and the member logs in again with the new password

#### Scenario: member removal
- **WHEN** a member is removed from the household
- **THEN** all of their sessions are revoked

### Requirement: A member sees and ends their own sessions
An authenticated member SHALL be able to list their active sessions, each with its device (from the browser's user agent), client address, creation time and last use, with the current session marked. The member SHALL be able to revoke any one of their own sessions, and all of their sessions except the current one. Sessions of other members SHALL be neither listed nor revocable (answered 404).

#### Scenario: device list
- **WHEN** a member signed in on a laptop and a phone opens the device list on the laptop
- **THEN** both sessions are listed, the laptop's marked as the current one

#### Scenario: sign out another device
- **WHEN** the member revokes the phone's session from the laptop
- **THEN** the phone's next request is answered 401 and the laptop stays signed in

#### Scenario: sign out all other devices
- **WHEN** the member chooses to sign out all other devices
- **THEN** every session of the member except the current one is revoked

#### Scenario: someone else's session
- **WHEN** a member tries to revoke a session that belongs to another member
- **THEN** the request is answered 404 and the session stays active

#### Scenario: revoking the current session
- **WHEN** a member revokes their current session from the device list
- **THEN** it behaves like a logout

### Requirement: Open live connections end with their session
A long-lived connection (the live counts stream) SHALL end within one update interval after its session is revoked or expires, or its member is removed, and SHALL tell the client the session ended, so the client stops reconnecting.

#### Scenario: device signed out while the app is open
- **WHEN** a member's phone has the app open and the member signs that phone out from another device
- **THEN** the phone's live counts stream ends with a "session ended" notice and does not reconnect
