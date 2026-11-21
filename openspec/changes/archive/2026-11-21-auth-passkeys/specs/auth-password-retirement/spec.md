# Spec Delta

## Purpose

How members who signed up with a password move to passkeys, why their password stops working afterwards, and how new members join with a passkey.

## ADDED Requirements

### Requirement: A password only leads to passkey enrolment
A member who has no passkey yet SHALL still be able to sign in with username and password, but the resulting session SHALL only allow enrolling a passkey (and signing out); every other request SHALL be refused with 403. Enrolling the first passkey SHALL generate the member's recovery codes and give them a full session.

#### Scenario: first login after the upgrade
- **WHEN** an existing member signs in with their password after the upgrade
- **THEN** they are asked to create a passkey and are shown recovery codes before they can use the app

#### Scenario: restricted password session
- **WHEN** such a session requests the library before a passkey exists
- **THEN** it is answered 403

#### Scenario: no passkey possible on this address
- **WHEN** a member signs in with their password on an address where passkeys can't work and leaves without enrolling
- **THEN** their password keeps working for the next attempt on a working address

### Requirement: Password login ends once a passkey exists
Once a member has enrolled a passkey, signing in with their password SHALL be refused exactly like a wrong password, permanently. Changing a password SHALL no longer be offered.

#### Scenario: password after enrolment
- **WHEN** a member who has enrolled a passkey tries to sign in with their (correct) old password
- **THEN** it is refused like a wrong password and counts toward the login limit

#### Scenario: no password change
- **WHEN** a member opens their account settings
- **THEN** there is no password form, only passkeys, recovery codes and devices

### Requirement: Invites enrol a passkey
Redeeming an invite SHALL ask for a username and create a passkey for the new member instead of a password, generate their recovery codes and sign them in. An invite SHALL stay unused when the passkey ceremony fails or is cancelled. Every other invite property (single use, 7 days, uniform answer for invalid links, per-address limit) stays as it is.

#### Scenario: join with a passkey
- **WHEN** an invitee opens their link, picks a username and creates a passkey
- **THEN** they are a member, signed in, with recovery codes shown once, and have no password

#### Scenario: cancelled ceremony
- **WHEN** the invitee cancels the passkey dialog
- **THEN** the invite can still be used

### Requirement: Password retirement is recorded
The system SHALL record when a member's password login was retired, with time, member and session.

#### Scenario: retirement
- **WHEN** a member enrols their first passkey after a password sign-in
- **THEN** the record shows that member's password retired
