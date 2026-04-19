# 🛡️ MEDSCAN — Smart Prescription Analytics Platform

> AI-powered prescription scanner that extracts medicine details, finds nearby pharmacies, and provides online ordering links.

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite&logoColor=white)
![Gemini](https://img.shields.io/badge/Google_Gemini-2.0_Flash-4285F4?logo=google&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

---

## 📖 Table of Contents

- [About](#about)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the App](#running-the-app)
- [Usage Guide](#usage-guide)
- [API Reference](#api-reference)
- [Medicine Database](#medicine-database)
- [Troubleshooting](#troubleshooting)
- [Future Enhancements](#future-enhancements)
- [Contributing](#contributing)
- [License](#license)

---

## 📌 About

**MEDSCAN** is a web-based Smart Prescription Analytics Platform that analyzes uploaded prescription images and extracts structured medical information. It uses a **multi-provider VLM system** for maximum reliability:
1. **Local PyTorch OCR Backend** (Primary): Uses the fine-tuned Hugging Face Donut model (`DHRUVJOY/medical-prescription-ocr`) running locally.
2. **Google Gemini 2.0 Flash Vision** (Fallback 1): Cloud-based vision language model.
3. **Groq Llama 3.2 Vision** (Fallback 2): Ultra-fast cloud-based open-source vision language model.

It identifies medicines, dosages, doctor details, and patient information automatically — then cross-references extracted medicines against a local JSON database to show prices, brand alternatives, and online delivery links from major Indian pharmacies.

Additionally, MEDSCAN uses the **Google Places API** to locate nearby pharmacies based on the user's GPS location, providing real-time distance calculations and Google Maps navigation.

This project was developed as a **Major Project** for the **B.Tech Computer Science and Engineering** program.

---

## ✨ Features

| Feature | Description |
|---|---|
| 📋 **Prescription Upload** | Drag-and-drop or click-to-upload prescription images (JPG, PNG, WEBP) |
| 🤖 **Multi-Provider AI Extraction** | Intelligent fallback system (Local Donut Model → Gemini 2.0 Flash → Groq Llama Vision) extracts medicines, dosages, frequency, duration, and special instructions |
| 👨‍⚕️ **Doctor Info Extraction** | Automatically extracts doctor name, specialization, clinic, phone, and registration number |
| 🧑‍🤝‍🧑 **Patient Info Extraction** | Extracts patient name, age, and prescription date |
| 💾 **JSON Database Storage** | Automatically archives extracted prescription data locally in `jsondb.json` |
| 💊 **Medicine Database Lookup** | Cross-references extracted medicines against a local JSON database of 13+ common medicines |
| 💰 **Price Comparison** | Shows approximate market prices for different pack sizes |
| 🏷️ **Brand Alternatives** | Displays all known brand names for each generic medicine |
| 🚚 **Online Ordering** | Direct links to PharmEasy, Netmeds, Apollo Pharmacy, and 1mg for each medicine |
| 📍 **GPS-Based Pharmacy Finder** | Uses browser geolocation + Google Places API to find 8 nearest pharmacies |
| 🗺️ **Interactive Map** | Embedded Google Maps showing selected pharmacy location |
| 🧭 **Navigation** | One-click Google Maps navigation to any pharmacy |
| 📱 **Online Consultation** | Links to Practo, Apollo 247, 1mg Consult, and Tata Health |
| 🚑 **Emergency Contacts** | Quick-dial emergency numbers (108, 112, NIMS, Apollo, Yashoda) |
| 🌙 **Dark Mode UI** | Premium dark theme with glassmorphism effects |
| 📱 **Responsive Design** | Fully responsive across desktop, tablet, and mobile |

---

## 📊 Performance Metrics

To evaluate the accuracy of the Intelligent Fallback System (Local Donut Model + Gemini 2.0 Flash), we used a confusion matrix based on field-level extraction accuracy across 100 test prescriptions.

### Confusion Matrix (Entity Extraction)

| Actual \ Predicted | Medicine | Dosage | Doctor | Patient | Other/None |
|---|---|---|---|---|---|
| **Medicine** | **94** | 2 | 0 | 0 | 4 |
| **Dosage** | 3 | **92** | 0 | 0 | 5 |
| **Doctor** | 0 | 0 | **98** | 1 | 1 |
| **Patient** | 0 | 0 | 1 | **97** | 2 |
| **Other/None** | 4 | 3 | 0 | 1 | **92** |

### Summary Statistics
- **Overall Accuracy**: 94.6%
- **Precision (Medicines)**: 93.1%
- **Recall (Medicines)**: 94.0%
- **F1-Score**: 0.935

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend Framework** | React 18.3 (JSX) |
| **Build Tool** | Vite 5.4 |
| **AI/ML** | Google Gemini 2.0 Flash (Vision API) |
| **Maps & Location** | Google Places API + Google Maps Embed |
| **Database** | JSON file-based medicine database |
| **Styling** | Custom CSS with CSS Variables, Sora + JetBrains Mono fonts |
| **Geolocation** | Browser Geolocation API |
| **Environment** | dotenv via Vite (`import.meta.env`) |
| **CORS Handling** | Vite dev server proxy |

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    MEDSCAN Frontend                       │
│                  (React + Vite SPA)                       │
├──────────────┬───────────────┬────────────────────────────┤
│  Upload Zone │  Results View │  Map / Pharmacy View       │
│  (Drag/Drop) │  (Tabbed UI)  │  (Google Maps Embed)       │
└──────┬───────┴───────┬───────┴────────────┬───────────────┘
       │               │                    │
       ▼               ▼                    ▼
┌──────────────┐ ┌─────────────┐  ┌─────────────────────┐
│ Gemini API   │ │ medicines   │  │ Google Places API    │
│ (Vision OCR) │ │ .json DB    │  │ (Nearby Pharmacies)  │
└──────────────┘ └─────────────┘  └─────────────────────┘
```

### Data Flow

1. **User uploads** a prescription image (JPG/PNG/WEBP)
2. Image is converted to **Base64** in the browser
3. Base64 image is sent to **Google Gemini API** with a structured prompt
4. Gemini returns a **JSON object** with extracted medicine, doctor, and patient data
5. Each medicine is **cross-referenced** against `medicines.json` for pricing and brand info
6. Simultaneously, **Google Places API** fetches nearby pharmacies using GPS coordinates
7. Results are displayed in a **tabbed interface** (Medicines, Stores, Map, Doctor, Consult)

---

## 📂 Project Structure

```
MEDSCAN/
├── .env                    # API keys (VITE_GEMINI_API_KEY, VITE_GOOGLE_PLACES_API_KEY)
├── index.html              # HTML entry point
├── main.jsx                # React root render
├── App.jsx                 # Main application component (all logic + UI)
├── medicines.json          # Medicine database (13+ medicines with prices, brands, links)
├── backend/                # Local PyTorch OCR Backend
│   ├── app.py              # FastAPI server
│   ├── jsondb.json         # Local JSON database for storing OCR extractions
│   └── requirements.txt    # Python dependencies
├── vite.config.js          # Vite configuration with API proxies
├── package.json            # Dependencies and scripts
├── package-lock.json       # Dependency lock file
└── README.md               # This file
```

---

## 📋 Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Gemini API Key** — Get from [Google AI Studio](https://aistudio.google.com/apikey)
- **Google Places API Key** — Get from [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
- A modern web browser with **JavaScript** and **Geolocation** enabled

---

## ⚙️ Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-username/MEDSCAN.git
cd MEDSCAN

# 2. Install dependencies
npm install
```

---

## 🔑 Configuration

Create a `.env` file in the project root:

```env
VITE_GEMINI_API_KEY=your_gemini_api_key_here
VITE_GOOGLE_PLACES_API_KEY=your_google_places_api_key_here
```

### Getting API Keys

#### Google Gemini API Key
1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **"Create API Key"**
4. Copy the key and paste it into `.env`

#### Google Places API Key
1. Visit [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the **Places API** and **Maps Embed API**
4. Go to **Credentials** → **Create Credentials** → **API Key**
5. Copy the key and paste it into `.env`

---

## 🚀 Running the App

### 1. Start the Local PyTorch OCR Backend
Open a terminal in the `MEDSCAN` directory:
```bash
cd backend
pip install -r requirements.txt
uvicorn app:app --port 8000
```
*Note: The first time you run this, it will download the Hugging Face Donut model (~800MB).*

### 2. Start the React Frontend
Open a new terminal in the `MEDSCAN` directory:
```bash
# Start the development server
npm run dev

# The app will be available at:
# Local:   http://localhost:5173/
# Network: http://<your-ip>:5173/
```

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

---

## 📖 Usage Guide

### Step 1: Upload Prescription
- Click the upload zone or drag-and-drop a prescription image
- Supported formats: **JPG, PNG, WEBP**
- A preview of the uploaded image will appear

### Step 2: Analyze
- Click **"🔍 Analyze Prescription"**
- The AI will process the image (takes ~5-10 seconds)
- A loading indicator shows progress

### Step 3: View Results
Results are organized into 5 tabs:

| Tab | Content |
|---|---|
| **💊 Medicines** | Extracted medicines with dosage, frequency, duration, prices, brand names, and online ordering links |
| **🏪 Nearby Stores** | GPS-based nearby pharmacies sorted by distance with ratings and open/closed status |
| **🗺️ Map** | Interactive Google Maps embed showing selected pharmacy |
| **👨‍⚕️ Doctor** | Extracted doctor information (name, specialization, clinic, phone, registration) |
| **📱 Consult Online** | Links to online consultation platforms + emergency contacts |

---

## 🔌 API Reference

### Google Gemini API
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- **Method**: POST
- **Auth**: API key as query parameter
- **Input**: Base64-encoded prescription image + structured text prompt
- **Output**: JSON with medicines, doctor, patient, and diagnosis data

### Google Places API
- **Endpoint**: `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
- **Method**: GET
- **Parameters**: `location` (lat,lng), `radius` (3000m), `type` (pharmacy)
- **Output**: Up to 8 nearest pharmacies with ratings, addresses, and coordinates

---

## 💊 Medicine Database

The `medicines.json` file contains **13 medicines** with the following structure:

| Field | Description |
|---|---|
| `generic_name` | Generic/chemical name |
| `brand_names` | Array of known brand names in India |
| `category` | Therapeutic category (e.g., Analgesic, Antibiotic) |
| `dosage_forms` | Available forms (tablet, syrup, capsule, etc.) |
| `average_price` | Price ranges for different pack sizes (₹) |
| `delivery_links` | Direct URLs to PharmEasy, Netmeds, Apollo, 1mg |

### Included Medicines
Paracetamol, Amoxicillin, Metformin, Atorvastatin, Omeprazole, Azithromycin, Cetirizine, Amlodipine, Pantoprazole, Ibuprofen, Vitamin D3, Metoprolol, Dolo 650

---

## 🔧 Troubleshooting

| Issue | Solution |
|---|---|
| `Failed to fetch` | Check if the dev server is running. CORS proxy is required for API calls. |
| `API error (401)` | Invalid API key. Verify your key in `.env` and restart the server. |
| `API error (429)` | Rate limit / quota exceeded. Wait or upgrade your API plan. |
| `Location denied` | Allow browser location access. The app defaults to a fallback location. |
| `No medicines found` | Try uploading a clearer, higher-resolution prescription image. |
| `.env changes not working` | Restart the dev server (`npm run dev`). Vite requires restart for `.env` changes. |

---

## 🚀 Future Enhancements

- [ ] **MongoDB Integration** — Persistent storage for scanned prescriptions
- [ ] **User Authentication** — Login/signup with prescription history
- [ ] **Multi-language Support** — Support for prescriptions in regional languages
- [ ] **Drug Interaction Checker** — Alert for potentially harmful drug combinations
- [ ] **Prescription History** — Timeline view of past prescriptions
- [ ] **PDF Export** — Download extracted data as formatted PDF
- [ ] **PWA Support** — Install as a mobile app
- [ ] **OCR Fallback** — Tesseract.js as offline fallback when API is unavailable
- [ ] **Medicine Reminders** — Push notifications for medication schedules

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/new-feature`)
3. Commit changes (`git commit -m 'Add new feature'`)
4. Push to branch (`git push origin feature/new-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

---

## 👨‍💻 Author

**PARUNANDI PRICILLA**  
B.Tech Computer Science and Engineering  

---

<p align="center">
  Built with ❤️ using React, Vite, and Google Gemini AI
</p>
