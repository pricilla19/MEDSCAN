# MEDSCAN System Test Cases

This document outlines the comprehensive test cases for the MEDSCAN Smart Prescription Analytics Platform. The test cases cover the frontend UI, AI orchestration fallback mechanisms, local database lookups, and geolocation services based on the established system architecture.

---

## 1. UI and Frontend Interaction Tests

| Test ID | Module | Description | Prerequisites | Test Steps | Expected Result |
|---|---|---|---|---|---|
| TC-UI-01 | File Upload | Verify image upload functionality via drag-and-drop. | App is running. | 1. Drag a valid `.jpg` image into the upload zone. | Image preview is displayed successfully. |
| TC-UI-02 | File Upload | Verify invalid file format rejection. | App is running. | 1. Attempt to upload a `.pdf` or `.txt` file. | System displays an error message indicating unsupported format. |
| TC-UI-03 | Navigation Tabs | Verify switching between result tabs. | App has extracted data successfully. | 1. Click on "Medicines", "Stores", "Map", "Doctor", and "Consult" tabs sequentially. | Correct tab content is rendered without page reload. |
| TC-UI-04 | Responsive Design | Verify UI rendering on mobile viewports. | App is running. | 1. Resize browser window to 375px width (mobile). | UI elements stack vertically; menus and cards remain readable. |
| TC-UI-05 | SOS Emergency | Verify SOS panel emergency contacts. | App is running. | 1. Navigate to the "Consult Online / SOS" tab.<br>2. Click on an emergency number link. | Browser prompts dialer application to initiate call. |

## 2. AI Extraction and Fallback Orchestration

| Test ID | Module | Description | Prerequisites | Test Steps | Expected Result |
|---|---|---|---|---|---|
| TC-AI-01 | Local Model Inference | Verify extraction using the Local Donut OCR. | Backend is running on port 8000, model is downloaded. | 1. Upload a clear prescription image.<br>2. Click "Analyze". | System connects to `localhost:8000`, extracts JSON, and displays results in < 2 seconds. |
| TC-AI-02 | Tier 1 Fallback (Gemini) | Verify fallback to Gemini 2.0 Flash when local model fails. | Stop FastAPI backend server to simulate failure. Gemini API key is valid. | 1. Upload prescription.<br>2. Click "Analyze". | Local fetch fails, system automatically switches to Gemini API, extraction succeeds. |
| TC-AI-03 | Tier 2 Fallback (Groq) | Verify fallback to Groq Llama 3.2 Vision when Gemini fails. | Stop local DB, and set an invalid Gemini API key in `.env`. | 1. Upload prescription.<br>2. Click "Analyze". | Both Local and Gemini fail, system defaults to Groq API and extracts data successfully. |
| TC-AI-04 | Extraction Accuracy | Verify data structuring format. | Gemini API is functional. | 1. Upload test prescription image. | Extracted JSON correctly separates fields: Patient details, Doctor details, and Medicine arrays. |

## 3. Database Lookup & Fuzzy Matching

| Test ID | Module | Description | Prerequisites | Test Steps | Expected Result |
|---|---|---|---|---|---|
| TC-DB-01 | Exact Generic Match | Verify query for an exact generic medicine name. | `medicines.json` is loaded. | 1. System extracts "Paracetamol". | Lookup engine matches "paracetamol" and returns pricing/delivery links. |
| TC-DB-02 | Fuzzy Brand Match | Verify query for a brand name instead of generic. | `medicines.json` is loaded. | 1. System extracts "Dolo 650". | Fuzzy matcher identifies "Dolo 650" as a brand of Paracetamol and returns Paracetamol data. |
| TC-DB-03 | Unlisted Medicine | Verify behavior when medicine is missing from DB. | `medicines.json` is loaded. | 1. System extracts "UnknownDrugX". | System displays extracted name but shows "Price data unavailable" or "No links found" fallback UI. |
| TC-DB-04 | Local Logging | Verify OCR extraction payload is saved locally. | Backend is running. | 1. Complete an analysis successfully.<br>2. Check `backend/jsondb.json`. | The extracted JSON payload is permanently appended to `jsondb.json`. |

## 4. Geolocation and Google Maps Services

| Test ID | Module | Description | Prerequisites | Test Steps | Expected Result |
|---|---|---|---|---|---|
| TC-GEO-01 | GPS Allowance | Verify nearby pharmacy fetch when GPS is allowed. | Google Places API key is valid. | 1. Allow browser location prompt.<br>2. System triggers pharmacy search. | Returns up to 8 nearby pharmacies with names, ratings, and open status. |
| TC-GEO-02 | GPS Denial | Verify fallback behavior when GPS is blocked. | Google Places API key is valid. | 1. Deny browser location prompt. | System falls back to default coordinates or prompts user to allow location for store features. |
| TC-GEO-03 | Distance Calculation | Verify Haversine distance accuracy. | User coordinates known. | 1. Review listed nearby stores. | Distances shown (e.g., "1.2 km away") mathematically match the Haversine calculation between user and store coordinates. |
| TC-GEO-04 | Map Embedding | Verify Google Maps iframe loads correct location. | Valid embed API key. | 1. Click on a specific pharmacy from the "Stores" tab.<br>2. Navigate to "Map" tab. | Embedded map centers precisely on the selected pharmacy's latitude/longitude. |

## 5. Security & Error Handling

| Test ID | Module | Description | Prerequisites | Test Steps | Expected Result |
|---|---|---|---|---|---|
| TC-SEC-01 | API Key Isolation | Verify API keys are not exposed in frontend globals. | App is running. | 1. Inspect window/global objects in browser dev tools. | API keys (`VITE_GEMINI_API_KEY`, etc.) are securely bundled and not accessible via `window.process` or similar. |
| TC-SEC-02 | API Rate Limiting | Verify app handles 429 errors gracefully. | Use a rate-limited API key. | 1. Upload and analyze. | Application catches 429 response and displays an actionable error to the user (e.g., "Quota Exceeded, try later"). |
| TC-SEC-03 | CORS Handling | Verify FastAPI communication from React frontend. | Both apps running. | 1. Initial local extraction attempt. | Proxy or CORS settings prevent `No-Access-Control-Allow-Origin` errors; request succeeds. |
| TC-SEC-04 | Empty JSON Fallback | Verify UI behavior when AI returns invalid/empty JSON. | Image is completely unintelligible. | 1. Upload a blurry, non-prescription image. | System catches parsing error, displays user-friendly "Could not extract, please re-upload" message without crashing. |
