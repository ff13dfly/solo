# Administrator Service Data & API

## Data Structure (Redis)

### Operator Entity
*   **Key**: `operator:<uid>` (Base58 UID)
*   **Type**: `JSON String`
*   **Schema**:
    ```json
    {
      "id": "String (Base58 UID)",
      "name": "String",
      "salt": "String (Hex)",
      "hash": "String (Hex)",
      "role": "operator",
      "devices": {
        "deviceId": { "last": "ISO Date", "token_prefix": "String" }
      },
      "create": "ISO Date",
      "last": "ISO Date",
      "disabled": "Boolean"
    }
    ```

### Name Mapping
*   **Key**: `operator:name:<name>`
*   **Type**: `String`
*   **Value**: `<uid>`

### Operator Index
*   **Key**: `operator:ids`
*   **Type**: `Set` (of UIDs)

### Auth Challenge (Ephemeral)
*   **Key**: `operator_challenge:<name>`
*   **Type**: `String` (TTL 120s)

### Session (Ephemeral)
*   **Key**: `operator_session:<token>`
*   **Type**: `JSON String` (TTL 7 days)

---

## API Methods

### `register`
*   **Input**:
    *   `name` (string, required): Username.
    *   `salt` (string, required): Hex salt.
    *   `hash` (string, required): Hex login hash.
*   **Output**: `{ success: true, uid: string }`
*   **AI Support**: False
*   **Redis**:
    *   Sets `operator:<uid>`.
    *   Sets `operator:name:<name>`.
    *   Adds to `operator:ids`.

### `list`
*   **Input**: None.
*   **Output**: `{ operators: Array<Operator> }` (Excludes security fields).
*   **AI Support**: True
*   **Redis**:
    *   Scans `operator:ids`.
    *   Multigets `operator:<uid>`.

### `updateStatus`
*   **Input**:
    *   `name` (string, required): Username.
    *   `disabled` (boolean, required): New status.
*   **Output**: `{ success: true }`
*   **AI Support**: True
*   **Redis**:
    *   Gets ID from `operator:name:<name>`.
    *   Updates `operator:<uid>`.
    *   (If disabled) Deletes `operator_challenge:<name>`.

### `changePassword`
*   **Input**:
    *   `name` (string, required): Username.
    *   `salt` (string, required): New salt.
    *   `hash` (string, required): New hash.
*   **Output**: `{ success: true }`
*   **AI Support**: True
*   **Redis**:
    *   Gets ID from `operator:name:<name>`.
    *   Updates `operator:<uid>`.

### `loginRequest`
*   **Input**:
    *   `name` (string, required): Username.
*   **Output**: `{ challenge: string, salt: string, iterations: number }`
*   **AI Support**: False
*   **Redis**:
    *   Gets ID from `operator:name:<name>`.
    *   Sets `operator_challenge:<name>`.

### `loginVerify`
*   **Input**:
    *   `name` (string, required): Username.
    *   `challenge` (string, required): Challenge string.
    *   `response` (string, required): Verify hash.
    *   `deviceId` (string, optional): Device ID.
*   **Output**: `{ success: true, token: string, uid: string, role: string }`
*   **AI Support**: False
*   **Redis**:
    *   Gets/Deletes `operator_challenge:<name>`.
    *   Sets `operator_session:<token>`.
    *   Updates `operator:<uid>` (device info).

### `administrator.error.list`
*   **Input**:
    *   `service` (string, optional): Service name filter.
*   **Output**: `{ errors: Array<ErrorLog> }`
*   **AI Support**: True
*   **Redis**:
    *   Reads `ERROR:QUEUE:<service>` list.

### `administrator.error.clear`
*   **Input**:
    *   `service` (string, required): Service name.
*   **Output**: `{ success: true }`
*   **AI Support**: True
*   **Redis**:
    *   Deletes `ERROR:QUEUE:<service>`.
