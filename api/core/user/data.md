# User Service Data & API

## Data Structure (Redis)

### User Entity
*   **Key**: `user:<uid>` (Base58 UID)
*   **Type**: `JSON String`
*   **Schema**:
    ```json
    {
      "id": "String",
      "name": "String",
      "phone": "String",
      "salt": "String (Hex)",
      "hash": "String (Hex)",
      "way": "Number",
      "devices": { "deviceId": { "last": "ISO Date", "token_prefix": "String" } },
      "create": "ISO Date",
      "last": "ISO Date",
      "permit": { "allow_all": "Boolean", "services": { "serviceName": ["methods"] } },
      "categories": { "CategoryKey": "ItemId" }
    }
    ```

### Name Mapping
*   **Key**: `user:name:<name>`
*   **Type**: `String` (Value: UID)

### User Index
*   **Key**: `user:ids`
*   **Type**: `Set` (of UIDs)

### Auth Challenge
*   **Key**: `challenge:<name>`
*   **Type**: `String` (TTL 120s)

### Session
*   **Key**: `user_session:<token>`
*   **Type**: `JSON String` (TTL 7 days)

### Category Configuration
*   **Key**: `USER:CONFIG:CATEGORY:<key>`
*   **Type**: `JSON String` (Array of category items)
*   **Schema**:
    ```json
    [
      {
        "id": "String",
        "label": { "zh": "String", "en": "String" },
        "desc": "String",
        "parentId": "String (optional)",
        "createdAt": "Number (Timestamp)"
      }
    ]
    ```

---

## API Methods

### `user.register`
*   **Input**:
    *   `name` (string, required): Username.
    *   `phone` (string, optional): Phone number.
    *   `salt` (string, required): Hex salt.
    *   `hash` (string, required): Hex hash.
*   **Output**: `{ success: true, uid: string }`
*   **Redis**:
    *   Sets `user:<uid>`.
    *   Sets `user:name:<name>`.
    *   Adds to `user:ids`.

### `user.loginRequest`
*   **Input**:
    *   `name` (string, required): Username.
*   **Output**: `{ challenge: string, salt: string, iterations: number }`
*   **Redis**:
    *   Gets `user:name:<name>`.
    *   Sets `challenge:<name>`.

### `user.loginVerify`
*   **Input**:
    *   `name` (string, required): Username.
    *   `challenge` (string, required).
    *   `response` (string, required).
    *   `deviceId` (string, optional).
*   **Output**: `{ success: true, token: string, uid: string, permit: string }`
*   **Redis**:
    *   Gets/Deletes `challenge:<name>`.
    *   Sets `user_session:<token>`.
    *   Updates `user:<uid>`.
    
### `user.permit.update` (Admin Only)
*   **Input**:
    *   `uid` (string, required): Target user ID.
    *   `permit` (object, required): Permission object.
*   **Output**: `{ success: true, uid: string }`
*   **Redis**:
    *   Updates `user:<uid>`.

### `user.permit.get` (Admin Only)
*   **Input**:
    *   `uid` (string, required): Target user ID.
*   **Output**: `{ uid: string, permit: object }`

### `user.permit.batch` (Admin Only)
*   **Input**:
    *   `permits` (array, required): List of `{ uid, permit }`.
*   **Output**: `{ results: [{ uid, success, error? }] }`

### `user.category.*`
Managed via RPC interface, backed by local Redis.
*   **Methods**: `create`, `update`, `delete`, `list`, `get`, `item.add`, `item.update`, `item.remove`.
*   **Data Key**: `USER:CONFIG:CATEGORY:<key>`

