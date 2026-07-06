# Agent Service Data & API

This service currently uses mock providers but is structured to integrate with AI APIs (OpenAI, Whisper).

## API Methods

### `agent.image.parse`
*   **Input**:
    *   `image` (string, required): Base64 encoded image or URL.
    *   `prompt` (string, optional): Context for parsing.
*   **Output**: `{ success: true, data: object, metadata: object }`
*   **Redis**: None (Stateless/Mock).

### `agent.audio.transcribe`
*   **Input**:
    *   `audio` (string, required): Base64 encoded audio or URL.
*   **Output**: `{ success: true, text: string, metadata: object }`
*   **Redis**: None (Stateless/Mock).

### `agent.text.parse`
*   **Input**:
    *   `text` (string, required): Natural language text.
    *   `schema` (object, optional): Desired output structure.
*   **Output**: `{ success: true, data: object, metadata: object }`
*   **Redis**: None (Stateless/Mock).
