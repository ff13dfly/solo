# Fulfillment Service Test Cases

## Unit Tests (Logic)

- **Instance**: create, get, list, transition (DRAFT→DEPOSIT_PENDING, condition not met rejection)
- **Profile**: create, get, list, update, delete (soft), restore, destroy
- **Rules**: evaluateCondition (null rule, truthy rule, falsy rule), resolveParams (var substitution)

## State Machine Tests

- **Valid transitions**: DRAFT → DEPOSIT_PENDING, DEPOSIT_PENDING → DEPOSIT_CONFIRMED
- **Invalid transition**: rejected when no matching rule in profile
- **Condition gate**: rejected when JsonLogic condition evaluates false
- **Task emission**: _tasks populated from transition actions

## Security Tests

- **Level 3 Handshake**: seed/verify flow
- **Public Methods**: ping / methods / entities bypass auth
- **Router Signature**: only signed requests pass

## Compliance

- **Introspection**: all routed methods present in introspection array
- **AI Semantic**: en/zh descriptions cover all methods
- **Entity Schema**: fulfillment_instance and fulfillment_profile defined
- **Soft Delete**: fulfillment_profile softDelete=true, methods implemented
