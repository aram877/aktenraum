# Spec Delta

## Purpose

How a household gains members: the household admin invites people with single-use links, invitees join as members with their own private space, and the admin can see who belongs to the household.

## ADDED Requirements

### Requirement: The household admin can create invite links
The household admin SHALL be able to create an invite link. Each link SHALL be usable exactly once and SHALL expire 7 days after creation. The secret part of the link SHALL be shown only once, at creation, and SHALL NOT be stored in readable form. Members without the household admin role SHALL NOT be able to create, list or revoke invites.

#### Scenario: admin creates an invite
- **WHEN** the household admin creates an invite
- **THEN** the response contains a link token and its expiry 7 days ahead, and the invite appears in the list of pending invites

#### Scenario: a plain member tries to create an invite
- **WHEN** a member without the household admin role asks to create an invite
- **THEN** the request is refused with 403 and no invite is created

### Requirement: Pending invites can be listed and revoked
The household admin SHALL see every invite that is neither redeemed, revoked nor expired, with its creation and expiry time, and SHALL be able to revoke any of them. A revoked invite SHALL NOT be redeemable.

#### Scenario: revoke
- **WHEN** the admin revokes a pending invite and someone then opens its link
- **THEN** the link is reported as invalid and cannot be redeemed

### Requirement: An invitee joins by choosing a username and password
Anyone holding a valid invite link SHALL be able to check that it is valid without logging in, and redeem it by choosing a username (unique, 3–64 characters) and a password (at least 8 characters). Redemption SHALL create a user with the household role `member`, a personal space owned by them, and their Paperless user and group, mark the invite as used, and log the new member in.

#### Scenario: redeem
- **WHEN** an invitee redeems a valid link with an unused username and a valid password
- **THEN** they are logged in as a new member, their personal space exists and is empty, and the invite is no longer pending

#### Scenario: link used twice
- **WHEN** a second person opens an already redeemed link
- **THEN** the link is reported as invalid and redemption is refused

#### Scenario: expired link
- **WHEN** someone opens a link more than 7 days after it was created
- **THEN** the link is reported as invalid and redemption is refused

#### Scenario: username taken
- **WHEN** an invitee chooses a username that already exists
- **THEN** redemption is refused with a message saying so, and the invite stays redeemable

### Requirement: Redemption is protected against guessing
Checking and redeeming invite links SHALL be rate-limited per client address, and an invalid, expired, revoked or used link SHALL produce the same response so that the state of a guessed token is not revealed.

#### Scenario: repeated guesses
- **WHEN** one client sends more than 10 invalid redemption attempts within 15 minutes
- **THEN** further attempts are answered with 429 and a `Retry-After` header

### Requirement: The household admin sees the household's members
The household admin SHALL be able to list every member of the household with username, household role and the date they joined.

#### Scenario: after a redemption
- **WHEN** the admin opens the member list after an invite was redeemed
- **THEN** the list shows the admin and the new member with role `member`
