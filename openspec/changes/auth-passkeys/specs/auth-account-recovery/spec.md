# Spec Delta

## Purpose

How a member gets back in without a working passkey — recovery codes and single-use setup links — and what such a session may do.

## ADDED Requirements

### Requirement: Every member has recovery codes
When a member's first passkey is created, the system SHALL generate 10 single-use recovery codes, show them once, and store only one-way hashes of them. A member SHALL be able to see how many unused codes remain and to generate a new set, which invalidates every unused code of the old set; generating SHALL require a recent confirmation (step-up). Codes SHALL be long enough that guessing one is impractical even with the stored hashes.

#### Scenario: codes with the first passkey
- **WHEN** a member creates their first passkey
- **THEN** they are shown 10 recovery codes once, and only hashes are stored

#### Scenario: regenerate
- **WHEN** a member generates a new set of recovery codes
- **THEN** every unused code of the previous set stops working

### Requirement: A recovery code signs in only to enrol a new passkey
A member SHALL be able to sign in with their username and one unused recovery code. The code SHALL be used up whether or not enrolment follows. The resulting session SHALL only allow enrolling a new passkey (and signing out); every other request SHALL be refused with 403 until a passkey has been enrolled, after which the member receives a full session. Wrong codes SHALL count toward the login limits per username and per client address. The answer to a wrong code SHALL not reveal whether the username exists.

#### Scenario: lost phone
- **WHEN** a member whose only passkey was on a lost phone signs in with a recovery code
- **THEN** they are asked to create a new passkey before they can see any document

#### Scenario: code used once
- **WHEN** the same recovery code is entered a second time
- **THEN** it is refused

#### Scenario: restricted session
- **WHEN** a session started with a recovery code requests the library before a passkey is enrolled
- **THEN** it is answered 403

#### Scenario: guessing codes
- **WHEN** 10 wrong recovery codes are entered for one username within 15 minutes
- **THEN** the next attempt for that username is answered 429

### Requirement: Setup links enrol a passkey without any existing credential
A setup link SHALL be single use, expire 30 minutes after creation, and be stored only as a one-way hash. Opening it SHALL let the person enrol a passkey for the member it was issued for, receive a new set of recovery codes (invalidating the old set), and be signed in. Every invalid state (unknown, expired, used, revoked, member removed) SHALL be answered the same way. Setup-link checks SHALL be limited per client address.

Setup links SHALL be issued:
- by the first run, for the household admin of a new installation (instead of a password);
- by the household admin for another member of the household (with a recent confirmation), shown once;
- by a command on the host machine for any member, as the last resort when no one can sign in.

#### Scenario: first run
- **WHEN** a new installation finishes its first run
- **THEN** it prints a setup link with which the admin creates the first passkey, and no password is set up

#### Scenario: member locked out
- **WHEN** a member has lost every passkey and every recovery code and the household admin issues a setup link for them
- **THEN** the member can enrol a new passkey with it within 30 minutes, once

#### Scenario: single-member household locked out
- **WHEN** the only member has lost every passkey and every code
- **THEN** a setup link can be issued by a command run on the host machine

#### Scenario: expired link
- **WHEN** a setup link is opened after 30 minutes
- **THEN** it answers like an unknown link and nothing is enrolled

### Requirement: Recovery events are recorded
The system SHALL record recovery codes generated and used, setup links created (with who issued them, or "host") and used, and recovery-code sign-ins (successful and failed, with the attempted username), with time, member, session, client address and user agent. Codes, links and their hashes SHALL NOT be recorded.

#### Scenario: setup link by the admin
- **WHEN** the household admin issues a setup link for a member and the member uses it
- **THEN** the record shows the link created by the admin for that member, and used
