# Spec Delta

## Purpose

Protection of the public sign-in entry points against guessing — rate limits per account and per client address that survive restarts — and a durable record of authentication events.

## ADDED Requirements

### Requirement: Failed logins are limited per account and per client address
After 10 failed logins within 15 minutes for the same username, or from the same client address, further login attempts for that username or from that address SHALL be refused with 429 and a `Retry-After` header until the window has passed. A successful login SHALL clear the failures of that username. The answer to a failed login SHALL not reveal whether the username exists. The counts SHALL survive a restart of the service.

#### Scenario: guessing one account
- **WHEN** 10 wrong passwords are sent for one username within 15 minutes
- **THEN** the 11th attempt for that username is answered 429 with `Retry-After`, even with the correct password

#### Scenario: spraying many accounts from one address
- **WHEN** one client address sends 10 failed logins for different usernames within 15 minutes
- **THEN** its next login attempt is answered 429

#### Scenario: restart doesn't reset the count
- **WHEN** the service restarts after 10 failed attempts for a username
- **THEN** the next attempt for that username within the window is still answered 429

#### Scenario: a different address is not punished for another's spraying
- **WHEN** one client address is throttled
- **THEN** a member logging in from another address with a username that has no failures is not refused

### Requirement: Invite redemption is limited per client address
Invalid invite checks and redemptions SHALL count per client address with the same thresholds, and SHALL survive a restart.

#### Scenario: invite guessing
- **WHEN** one client address tries 10 invalid invite links within 15 minutes
- **THEN** its next invite request is answered 429

### Requirement: The client address is the browser's, not the proxy's
Rate limits, the device list and the audit log SHALL use the address of the connecting browser as seen by the edge proxy, not the address of the proxy itself.

#### Scenario: two browsers behind the same proxy
- **WHEN** two browsers on different machines reach the app through its proxy and one of them is throttled
- **THEN** the other is not throttled

### Requirement: Authentication events are recorded
The system SHALL record, with time, member (when known), session (when known), client address and user agent: successful logins, failed logins (with the attempted username), throttled attempts, logouts, session revocations (with who revoked and why: user, other device, password change, member removal), password changes and invite redemptions. Records SHALL be kept for 180 days and then deleted. Passwords and session tokens SHALL never be recorded.

#### Scenario: failed then successful login
- **WHEN** a member mistypes their password once and then logs in
- **THEN** the record shows one failed login for that username and one successful login for that member, each with the client address

#### Scenario: device signed out by the member
- **WHEN** a member signs out another device
- **THEN** the record shows that session revoked by that member with reason "other device"

#### Scenario: retention
- **WHEN** a record is older than 180 days
- **THEN** it is deleted
