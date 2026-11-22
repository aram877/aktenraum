# Spec Delta

## Purpose

How a user gets a dark theme, how the choice is kept, and that the document type colours and status colours stay readable in it.

## ADDED Requirements

### Requirement: The theme follows the device unless the user chooses
The SPA SHALL offer the modes System, Hell and Dunkel, default to System, and keep the choice on the device. In System mode it SHALL follow the device's dark setting, including when that setting changes while the app is open.

#### Scenario: default
- **WHEN** a device in dark mode opens the app for the first time
- **THEN** the app is dark

#### Scenario: manual choice
- **WHEN** the user switches to Hell on a device in dark mode and reloads
- **THEN** the app is light

#### Scenario: storage unavailable
- **WHEN** the browser blocks storage
- **THEN** the app uses System and the toggle still works for the current visit

### Requirement: Colours stay readable in both themes
Every area's text colour on its tint, the status colours and the secondary text colour SHALL have at least 4.5:1 contrast on their backgrounds in both themes.

#### Scenario: contrast test
- **WHEN** the unit tests run
- **THEN** they check these pairs for the light and the dark values
