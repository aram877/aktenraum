# Spec Delta

## Purpose

How a member registers, names, lists and removes passkeys, signs in with one, and on which addresses passkeys work.

## ADDED Requirements

### Requirement: Members sign in with a passkey
The login page SHALL offer signing in with a passkey without entering a username. A successful sign-in SHALL require user verification on the authenticator (PIN, fingerprint, face) and SHALL create a session for the member the passkey belongs to, with the full rights of that member. A passkey assertion that fails verification, belongs to no active passkey, or belongs to a removed member SHALL be answered 401 with the same answer in every case.

#### Scenario: sign in with a passkey
- **WHEN** a member chooses "Mit Passkey anmelden" and confirms with their authenticator
- **THEN** they are signed in as themselves, without having typed a username

#### Scenario: unknown or removed passkey
- **WHEN** an assertion is made with a passkey that was removed, or that belongs to a removed member
- **THEN** it is answered 401 and no session is created

#### Scenario: a challenge is used once
- **WHEN** a valid assertion is replayed with the same challenge
- **THEN** the second attempt is answered 401

### Requirement: Passkeys are bound to allowed addresses
The system SHALL accept passkey ceremonies only from configured origins and SHALL bind each passkey to the address (relying-party ID) it was created on. A passkey created on one address SHALL be offered and accepted only there. The device list SHALL show each passkey's address. When the app is opened on an address where passkeys can't work (not configured, or an IP address), the login page SHALL say so and name the addresses where passkey login works.

#### Scenario: second address
- **WHEN** a member who created a passkey on `localhost` opens the app on the configured Tailscale hostname
- **THEN** that passkey is not accepted there, and the member can add another passkey from that address

#### Scenario: unconfigured origin
- **WHEN** a passkey ceremony is started from an origin that is not configured
- **THEN** it is refused before any challenge is issued

#### Scenario: IP address
- **WHEN** the login page is opened via an IP address
- **THEN** it explains that passkeys don't work on IP addresses and lists the working addresses

### Requirement: A member manages their own passkeys
A signed-in member SHALL be able to list their passkeys, each with its name, provider (where the authenticator identifies it), whether it is synced or bound to one device, its address, creation time and last use; add another passkey (on the current device, or another device via the browser's cross-device flow); rename one; and remove one. A member SHALL NOT be able to remove their last passkey. Adding, renaming and removing SHALL require a recent confirmation (step-up); enrolling a passkey in a session that is restricted to enrolment (after a password, recovery-code or setup-link sign-in) SHALL NOT, because such a member has no passkey to confirm with. Passkeys of other members SHALL be neither listed nor changeable (answered 404). A new passkey SHALL be refused when the authenticator already holds one of the member's passkeys for that address.

#### Scenario: list
- **WHEN** a member with a Windows Hello passkey and a Google Password Manager passkey opens the passkey list
- **THEN** both are listed with provider, synced / device-bound, address and last use

#### Scenario: last passkey
- **WHEN** a member tries to remove their only passkey
- **THEN** the request is refused and the passkey stays

#### Scenario: someone else's passkey
- **WHEN** a member tries to rename or remove a passkey of another member
- **THEN** the request is answered 404 and nothing changes

#### Scenario: removed passkey no longer signs in
- **WHEN** a member removes a passkey and later tries to sign in with it
- **THEN** the sign-in is answered 401

### Requirement: Failed passkey sign-ins are limited per client address
Failed passkey sign-ins SHALL count toward the existing per-client-address login limit (10 failures in 15 minutes → 429 with `Retry-After`), and SHALL survive a restart.

#### Scenario: repeated failures
- **WHEN** one client address makes 10 failed passkey sign-ins within 15 minutes
- **THEN** its next login attempt of any kind is answered 429

### Requirement: Passkey events are recorded
The system SHALL record passkey sign-ins (successful and failed) and every passkey added, renamed or removed, with time, member, session (when known), client address and user agent. Credential public keys and authenticator responses SHALL NOT be recorded.

#### Scenario: passkey added
- **WHEN** a member adds a passkey
- **THEN** the record shows that member adding a passkey with its name and address
