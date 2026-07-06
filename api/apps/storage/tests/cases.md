# Storage Service Test Cases

## Asset Operations

### Upload Asset
- **Method**: `storage.asset.upload`
- **Goal**: Verify that base64 files can be uploaded and deduplicated.
- **Scenario**: Upload 'hello.txt' as base64, check for 8-char ID.

### Get Asset
- **Method**: `storage.asset.get`
- **Goal**: Retrieve metadata.
- **Scenario**: Use ID from upload to fetch original name.

### Resolve Asset
- **Method**: `storage.asset.resolve`
- **Goal**: Get public URL.
- **Scenario**: Verify URL contains `/assets/`.
