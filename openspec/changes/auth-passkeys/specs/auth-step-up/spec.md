# Spec Delta

## Purpose

Which actions need a fresh passkey confirmation, how long a confirmation lasts, and how the app obtains it without losing what the member was doing.

## ADDED Requirements

### Requirement: Sensitive actions need a recent passkey confirmation
The following actions SHALL succeed only when the session has a passkey confirmation from the last 5 minutes:
- permanently deleting a document and emptying the trash;
- adding, renaming or removing a passkey; generating new recovery codes;
- creating or revoking an invite, issuing a setup link, removing a household member;
- deleting a shared space, and adding, changing or removing its members;
- changing the extraction or answer model or the auto-approve rules.

Otherwise the request SHALL be refused with 403 and a machine-readable reason (`step_up_required`) and SHALL change nothing. Signing in with a passkey SHALL count as a confirmation at that moment.

#### Scenario: empty trash long after sign-in
- **WHEN** a member who signed in an hour ago empties the trash
- **THEN** the request is refused with `step_up_required` and the trash is unchanged

#### Scenario: right after a passkey sign-in
- **WHEN** a member signs in with a passkey and empties the trash within 5 minutes
- **THEN** it succeeds without another confirmation

#### Scenario: ordinary actions
- **WHEN** a member approves a document, edits fields or uploads
- **THEN** no confirmation is asked

### Requirement: A member confirms with one of their own passkeys
A signed-in member SHALL be able to confirm by completing a passkey assertion with user verification using one of their own active passkeys for the current address; this SHALL mark their current session confirmed for 5 minutes. An assertion with another member's passkey, or without user verification, SHALL be refused. Failed confirmations SHALL count toward the per-address login limit.

#### Scenario: confirm and retry
- **WHEN** a sensitive action is refused with `step_up_required` and the member confirms with their passkey
- **THEN** the app repeats the action and it succeeds, without the member re-entering anything

#### Scenario: another member's passkey
- **WHEN** a member tries to confirm using a passkey that belongs to someone else in the household
- **THEN** the confirmation is refused and the session stays unconfirmed

#### Scenario: confirmation expires
- **WHEN** more than 5 minutes have passed since the confirmation
- **THEN** the next sensitive action asks again

### Requirement: Confirmations are recorded
Successful and failed confirmations SHALL be recorded with time, member, session, client address and user agent.

#### Scenario: failed confirmation
- **WHEN** a member cancels or fails a confirmation
- **THEN** the record shows a failed confirmation for that member and session
