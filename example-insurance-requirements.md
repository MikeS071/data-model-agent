# Personal Auto Insurance Requirements

Create a data model for a simple personal auto insurance system.

The system must manage customers, insured vehicles, policies, coverage selections, premium payments, and claims.

## Customers

- A customer has a unique customer ID, full name, date of birth, email address, phone number, and postal address.
- A customer may hold multiple insurance policies.
- An email address should be unique when provided.
- A customer must be at least 16 years old to be listed as a driver.

## Vehicles

- A vehicle has a unique vehicle ID, VIN, registration number, make, model, manufacture year, and current market value.
- A VIN must be unique.
- A customer may own multiple vehicles.
- Each vehicle has one primary owner.
- A vehicle may be insured under multiple policies over time, but it must not have overlapping active policies.

## Policies

- A policy has a unique policy number, effective date, expiry date, status, annual premium, and billing frequency.
- Policy status may be `DRAFT`, `ACTIVE`, `CANCELLED`, or `EXPIRED`.
- A policy belongs to one policyholder customer.
- A policy must insure at least one vehicle.
- A policy may list multiple drivers.
- The expiry date must be later than the effective date.
- Only one policy version may be active at a time for a given policy number.

## Drivers

- A driver is a customer authorized to drive a vehicle covered by a policy.
- A policy must identify one primary driver for each insured vehicle.
- A driver may be listed on multiple policies.
- Store the driver's licence number, licence jurisdiction, and licence expiry date.
- A driver's licence number must be unique within its issuing jurisdiction.

## Coverage

- Available coverage types include liability, collision, comprehensive, and roadside assistance.
- A policy may have multiple coverage selections.
- Each selection records its coverage limit, deductible, and premium component.
- A policy must include liability coverage.
- Collision and comprehensive coverage require a positive deductible.
- Coverage selections apply to a specific insured vehicle.

## Premium payments

- A payment has a unique payment ID, policy ID, due date, paid date, amount, status, and payment reference.
- Payment status may be `DUE`, `PAID`, `FAILED`, `REFUNDED`, or `CANCELLED`.
- A policy may have multiple payments.
- A payment reference must be unique when present.
- A paid payment must have a paid date.
- The payment amount must be greater than zero.

## Claims

- A claim has a unique claim number, policy ID, vehicle ID, claimant customer ID, incident date, reported date, description, status, and estimated loss amount.
- Claim status may be `OPEN`, `UNDER_REVIEW`, `APPROVED`, `DENIED`, or `CLOSED`.
- A policy may have multiple claims.
- A claim must relate to a vehicle insured by the policy on the incident date.
- The reported date cannot be earlier than the incident date.
- The estimated loss amount cannot be negative.
- A closed claim must have an approved or denied outcome recorded.

## Audit requirements

- Store creation and last-updated timestamps for customers, vehicles, policies, payments, and claims.
- Preserve historical policies and claims rather than deleting them.
- Do not store credit card numbers or bank account details.
- Monetary amounts should use a fixed-precision decimal representation and include a three-letter currency code.

## Questions to clarify

- Can a vehicle have multiple legal owners?
- Should policy renewals create a new policy record or a new version of the existing policy?
- Can a claimant be someone other than a customer or listed driver?
- Should partial premium payments be supported?
- Which jurisdiction determines the minimum required liability coverage?
