#!/bin/bash
API_KEY=$(grep GEMINI_API_KEY ../../.env | cut -d '=' -f2)
MODEL="text-embedding-004"

echo "Testing $MODEL with curl..."
curl "https://generativelanguage.googleapis.com/v1beta/models/$MODEL:embedContent?key=$API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{ "content": { "parts":[{ "text": "Hello world" }] } }'
echo -e "\n\nTesting embedding-001 with curl..."
curl "https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=$API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{ "content": { "parts":[{ "text": "Hello world" }] } }'
