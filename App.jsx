import { useState, useEffect, useRef, useCallback } from "react";
import MEDICINE_DB from "./medicines.json";

// Database is now loaded from medicines.json

// ============================================================
// HELPERS
// ============================================================
function lookupMedicine(name) {
  const key = name.toLowerCase().trim();
  if (MEDICINE_DB.medicines[key]) return MEDICINE_DB.medicines[key];
  // fuzzy match
  for (const [dbKey, med] of Object.entries(MEDICINE_DB.medicines)) {
    if (dbKey.includes(key) || key.includes(dbKey)) return med;
    if (med.brand_names.some(b => b.toLowerCase().includes(key) || key.includes(b.toLowerCase()))) return med;
  }
  return null;
}

function getLowestPrice(priceObj) {
  const vals = Object.values(priceObj);
  return Math.min(...vals);
}

function calcDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// MULTI-PROVIDER VLM (Vision Language Model) — Prescription Analysis
// Supports: Gemini 2.0 Flash, Groq Llama 3.2 Vision
// Auto-fallback: tries each available provider in order
// ============================================================

const VLM_PROMPT = `You are a medical prescription analysis AI. Analyze this prescription image carefully and extract ALL information you can read.

Extract:
1. ALL medicines with their name, dosage, frequency, duration, and any special instructions
2. Doctor details: name, specialization, clinic/hospital, address, phone, registration number
3. Patient details: name, age, prescription date
4. Diagnosis or condition if mentioned

Be thorough — read handwritten text carefully. If a field is not visible or illegible, use an empty string.

Return ONLY a valid JSON object with this exact structure (no markdown, no code fences, no explanation):
{"medicines":[{"name":"","dosage":"","frequency":"","duration":"","instructions":""}],"doctor":{"name":"","specialization":"","clinic":"","address":"","phone":"","registration":""},"patient":{"name":"","age":"","date":""},"diagnosis":""}`;

const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    medicines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" }, dosage: { type: "STRING" },
          frequency: { type: "STRING" }, duration: { type: "STRING" },
          instructions: { type: "STRING" }
        }, required: ["name"]
      }
    },
    doctor: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" }, specialization: { type: "STRING" },
        clinic: { type: "STRING" }, address: { type: "STRING" },
        phone: { type: "STRING" }, registration: { type: "STRING" }
      }
    },
    patient: {
      type: "OBJECT",
      properties: { name: { type: "STRING" }, age: { type: "STRING" }, date: { type: "STRING" } }
    },
    diagnosis: { type: "STRING" }
  },
  required: ["medicines"]
};

// --- Provider: Gemini 2.0 Flash ---
async function callGemini(imageBase64, mimeType) {
  const key = import.meta.env.VITE_GEMINI_API_KEY || "";
  if (!key) return null; // skip if no key

  const url = `/api/gemini/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: VLM_PROMPT }
        ]
      }],
      generationConfig: {
        maxOutputTokens: 2048, temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: GEMINI_SCHEMA
      }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn("Gemini failed:", res.status, err);
    throw new Error(`Gemini error (${res.status})`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return JSON.parse(text);
}

// --- Provider: Groq (Llama 4 Scout / Llama 3.2 11B Vision) ---
async function callGroq(imageBase64, mimeType) {
  const key = import.meta.env.VITE_GROQ_API_KEY || "";
  if (!key) return null; // skip if no key

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  const models = ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.2-11b-vision-preview"];

  for (const model of models) {
    try {
      console.log(`  Groq: trying model ${model}...`);
      const res = await fetch("/api/groq/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: VLM_PROMPT }
            ]
          }],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: { type: "json_object" }
        })
      });

      if (!res.ok) {
        const err = await res.text();
        console.warn(`  Groq ${model} failed:`, res.status, err);
        continue; // try next model
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      const clean = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean);
    } catch (e) {
      console.warn(`  Groq ${model} error:`, e.message);
      continue;
    }
  }

  throw new Error("Groq: all models failed");
}

// --- Provider: Local Donut OCR Backend ---
async function callLocalOCR(imageBase64, mimeType) {
  const url = "/api/local-ocr/predict";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: imageBase64,
      mime_type: mimeType
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn("Local OCR failed:", res.status, err);
    throw new Error(`Local OCR error (${res.status})`);
  }

  const data = await res.json();
  
  // Checking if local model found any data
  const hasMedicines = data.medicines && data.medicines.length > 0;
  const hasDoctor = data.doctor && data.doctor.name;
  const hasPatient = data.patient && data.patient.name;
  
  if (!hasMedicines && !hasDoctor && !hasPatient) {
    throw new Error("Local Donut OCR returned empty result");
  }
  
  return data;
}

// --- Main extraction: tries providers in order ---
async function extractMedicinesFromPrescription(imageBase64, mimeType, onProgress) {
  const providers = [
    { name: "Local Donut Model", fn: callLocalOCR, key: "local" },
    { name: "Gemini 2.0 Flash", fn: callGemini, key: import.meta.env.VITE_GEMINI_API_KEY },
    { name: "Groq Llama Vision", fn: callGroq, key: import.meta.env.VITE_GROQ_API_KEY },
  ].filter(p => p.key); // only try providers that have a key configured

  if (providers.length === 0) {
    throw new Error("No VLM API key configured. Add VITE_GEMINI_API_KEY or VITE_GROQ_API_KEY to your .env file.");
  }

  const errors = [];
  for (const provider of providers) {
    try {
      console.log(`Trying VLM provider: ${provider.name}...`);
      if (onProgress) onProgress(`Trying ${provider.name}...`);
      const result = await provider.fn(imageBase64, mimeType);
      if (result) {
        console.log(`✅ ${provider.name} succeeded`);
        return result;
      }
    } catch (err) {
      console.warn(`❌ ${provider.name} failed:`, err.message);
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`All VLM providers failed:\n${errors.join("\n")}`);
}




// ============================================================
// GOOGLE PLACES API
// ============================================================
async function searchNearbyPharmacies(lat, lng) {
  const API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
  const url = `/api/google/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=3000&type=pharmacy&key=${API_KEY}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, 8).map(p => ({
        id: p.place_id,
        name: p.name,
        address: p.vicinity,
        lat: p.geometry.location.lat,
        lng: p.geometry.location.lng,
        rating: p.rating,
        open_now: p.opening_hours?.open_now,
        distance: calcDistance(lat, lng, p.geometry.location.lat, p.geometry.location.lng).toFixed(1),
        maps_url: `https://www.google.com/maps/dir/?api=1&destination=${p.geometry.location.lat},${p.geometry.location.lng}&travelmode=driving`,
        chain: p.name.toLowerCase().includes("apollo") ? "Apollo" :
          p.name.toLowerCase().includes("medplus") ? "MedPlus" :
            p.name.toLowerCase().includes("wellness") ? "Wellness" : "Independent"
      }));
    }
  } catch (e) {
    console.error("Places API error:", e);
  }

  // Fallback mocks if API fails or returns nothing (for demo purposes)
  return [
    { id: "mock1", name: "Apollo Pharmacy", address: "Banjara Hills, Hyderabad", lat: lat + 0.01, lng: lng + 0.01, rating: 4.5, open_now: true, distance: "0.8", maps_url: "#", chain: "Apollo" },
    { id: "mock2", name: "MedPlus", address: "Jubilee Hills, Hyderabad", lat: lat - 0.01, lng: lng + 0.01, rating: 4.2, open_now: true, distance: "1.2", maps_url: "#", chain: "MedPlus" },
    { id: "mock3", name: "Wellness Forever", address: "Gachibowli, Hyderabad", lat: lat + 0.01, lng: lng - 0.01, rating: 4.8, open_now: true, distance: "2.1", maps_url: "#", chain: "Wellness" },
    { id: "mock4", name: "Independent Bio Pharma", address: "Ameerpet, Hyderabad", lat: lat - 0.01, lng: lng - 0.01, rating: 3.9, open_now: false, distance: "2.5", maps_url: "#", chain: "Independent" }
  ];
}

// ============================================================
// STYLES
// ============================================================
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  
  * { box-sizing: border-box; margin: 0; padding: 0; }
  
  :root {
    --bg: #0a0e1a;
    --surface: #111827;
    --surface2: #1a2235;
    --border: #1e2d45;
    --accent: #00d4aa;
    --accent2: #0ea5e9;
    --accent3: #f59e0b;
    --danger: #ef4444;
    --text: #e2e8f0;
    --text-dim: #64748b;
    --text-muted: #374151;
    --radius: 12px;
  }
  
  body { font-family: 'Sora', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
  
  .app { min-height: 100vh; display: flex; flex-direction: column; }
  
  .header {
    background: linear-gradient(135deg, #0a0e1a 0%, #111827 100%);
    border-bottom: 1px solid var(--border);
    padding: 1.25rem 2rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    position: sticky;
    top: 0;
    z-index: 100;
    backdrop-filter: blur(12px);
  }
  
  .header-logo {
    width: 42px; height: 42px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.25rem;
    flex-shrink: 0;
  }
  
  .header-title { font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em; }
  .header-sub { font-size: 0.7rem; color: var(--text-dim); font-weight: 400; letter-spacing: 0.05em; text-transform: uppercase; }
  
  .badge {
    margin-left: auto;
    background: rgba(0,212,170,0.1);
    border: 1px solid rgba(0,212,170,0.3);
    color: var(--accent);
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 500;
    letter-spacing: 0.05em;
  }
  
  .main { flex: 1; max-width: 1200px; margin: 0 auto; width: 100%; padding: 2rem; }
  
  .upload-zone {
    border: 2px dashed var(--border);
    border-radius: 16px;
    padding: 3.5rem 2rem;
    text-align: center;
    cursor: pointer;
    transition: all 0.3s ease;
    background: var(--surface);
    position: relative;
    overflow: hidden;
  }
  
  .upload-zone::before {
    content: '';
    position: absolute;
    top: -50%;
    left: -50%;
    width: 200%;
    height: 200%;
    background: radial-gradient(circle at center, rgba(0,212,170,0.04) 0%, transparent 70%);
    pointer-events: none;
  }
  
  .upload-zone:hover, .upload-zone.drag-over {
    border-color: var(--accent);
    background: rgba(0,212,170,0.04);
    transform: translateY(-2px);
  }
  
  .upload-icon { font-size: 3rem; margin-bottom: 1rem; filter: grayscale(0.3); }
  .upload-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
  .upload-sub { color: var(--text-dim); font-size: 0.875rem; }
  
  .btn {
    padding: 0.6rem 1.25rem;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-family: 'Sora', sans-serif;
    font-weight: 500;
    font-size: 0.875rem;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
  }
  
  .btn-primary {
    background: linear-gradient(135deg, var(--accent), #00b890);
    color: #0a0e1a;
    font-weight: 600;
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,212,170,0.3); }
  
  .btn-outline {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
  }
  .btn-outline:hover { border-color: var(--accent); color: var(--accent); }
  
  .btn-ghost {
    background: var(--surface2);
    color: var(--text);
  }
  .btn-ghost:hover { background: var(--border); }
  
  .btn-sm { padding: 0.4rem 0.85rem; font-size: 0.8rem; }
  
  .section-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }
  
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  
  .section-pill {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.65rem;
    font-size: 0.7rem;
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
  }
  
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: rgba(0,212,170,0.25); }
  
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; }
  
  @media (max-width: 768px) {
    .grid-2, .grid-3 { grid-template-columns: 1fr; }
    .main { padding: 1rem; }
  }
  
  .tag {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 500;
  }
  .tag-green { background: rgba(0,212,170,0.12); color: var(--accent); border: 1px solid rgba(0,212,170,0.2); }
  .tag-blue { background: rgba(14,165,233,0.12); color: var(--accent2); border: 1px solid rgba(14,165,233,0.2); }
  .tag-amber { background: rgba(245,158,11,0.12); color: var(--accent3); border: 1px solid rgba(245,158,11,0.2); }
  .tag-red { background: rgba(239,68,68,0.12); color: var(--danger); border: 1px solid rgba(239,68,68,0.2); }
  
  .medicine-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: all 0.2s;
  }
  .medicine-card:hover { border-color: rgba(0,212,170,0.3); transform: translateY(-2px); }
  
  .med-header {
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  
  .med-name { font-weight: 700; font-size: 1rem; }
  .med-generic { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.2rem; font-family: 'JetBrains Mono', monospace; }
  
  .med-body { padding: 1rem 1.25rem; }
  
  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.8rem;
  }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--text-dim); }
  .info-value { font-weight: 500; text-align: right; }
  
  .price-box {
    background: var(--surface2);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 0.75rem 0;
  }
  
  .price-main { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
  .price-label { font-size: 0.7rem; color: var(--text-dim); }
  
  .delivery-links { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
  
  .delivery-btn {
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s;
    border: 1px solid transparent;
  }
  .pharmeasy { background: rgba(139,92,246,0.12); color: #a78bfa; border-color: rgba(139,92,246,0.25); }
  .pharmeasy:hover { background: rgba(139,92,246,0.2); }
  .netmeds { background: rgba(34,197,94,0.12); color: #4ade80; border-color: rgba(34,197,94,0.25); }
  .netmeds:hover { background: rgba(34,197,94,0.2); }
  .apollo-ph { background: rgba(14,165,233,0.12); color: #38bdf8; border-color: rgba(14,165,233,0.25); }
  .apollo-ph:hover { background: rgba(14,165,233,0.2); }
  .onemg { background: rgba(239,68,68,0.12); color: #f87171; border-color: rgba(239,68,68,0.25); }
  .onemg:hover { background: rgba(239,68,68,0.2); }
  
  .pharmacy-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    transition: all 0.2s;
    cursor: pointer;
  }
  .pharmacy-card:hover { border-color: rgba(14,165,233,0.4); background: rgba(14,165,233,0.03); }
  .pharmacy-card.selected { border-color: var(--accent2); background: rgba(14,165,233,0.06); }
  
  .chain-badge {
    width: 40px; height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    flex-shrink: 0;
    font-weight: 700;
    font-size: 0.65rem;
    text-align: center;
    line-height: 1.2;
  }
  .chain-apollo { background: rgba(14,165,233,0.15); color: var(--accent2); }
  .chain-medplus { background: rgba(34,197,94,0.15); color: #4ade80; }
  .chain-wellness { background: rgba(245,158,11,0.15); color: var(--accent3); }
  .chain-independent { background: rgba(148,163,184,0.15); color: #94a3b8; }
  
  .ph-name { font-weight: 600; font-size: 0.9rem; margin-bottom: 0.25rem; }
  .ph-address { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 0.5rem; line-height: 1.4; }
  .ph-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  
  .map-container {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    height: 400px;
    position: relative;
  }
  
  .map-frame { width: 100%; height: 100%; border: none; }
  
  .map-placeholder {
    width: 100%; height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    color: var(--text-dim);
  }
  
  .loading-bar {
    width: 100%;
    height: 3px;
    background: var(--border);
    border-radius: 999px;
    overflow: hidden;
  }
  .loading-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent2));
    border-radius: 999px;
    animation: loading 1.5s ease infinite;
  }
  @keyframes loading {
    0% { width: 0; margin-left: 0; }
    50% { width: 60%; margin-left: 20%; }
    100% { width: 0; margin-left: 100%; }
  }
  
  .doctor-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
  }
  
  .doc-avatar {
    width: 56px; height: 56px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(0,212,170,0.2), rgba(14,165,233,0.2));
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.75rem;
    flex-shrink: 0;
  }
  
  .doc-name { font-weight: 700; font-size: 1.05rem; margin-bottom: 0.25rem; }
  .doc-spec { font-size: 0.8rem; color: var(--accent); margin-bottom: 0.5rem; }
  .doc-info { font-size: 0.8rem; color: var(--text-dim); display: flex; gap: 0.5rem; align-items: center; margin: 0.25rem 0; }
  
  .consult-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    text-decoration: none;
    color: var(--text);
    transition: all 0.2s;
  }
  .consult-card:hover { border-color: rgba(0,212,170,0.35); transform: translateY(-1px); }
  
  .consult-icon { font-size: 1.75rem; }
  .consult-name { font-weight: 600; font-size: 0.9rem; }
  .consult-desc { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.15rem; }
  
  .preview-img {
    width: 100%;
    max-height: 250px;
    object-fit: contain;
    border-radius: 8px;
    background: var(--surface2);
  }
  
  .step-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    overflow-x: auto;
    padding-bottom: 0.5rem;
  }
  
  .step {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-dim);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .step.active { color: var(--accent); }
  .step.done { color: var(--text-dim); }
  
  .step-dot {
    width: 22px; height: 22px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    font-weight: 700;
    border: 1.5px solid var(--border);
    flex-shrink: 0;
  }
  .step.active .step-dot { background: var(--accent); border-color: var(--accent); color: #0a0e1a; }
  .step.done .step-dot { background: var(--surface2); border-color: var(--text-dim); }
  
  .step-line { flex: 1; height: 1px; background: var(--border); min-width: 20px; }
  
  .alert {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    font-size: 0.825rem;
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .alert-info { background: rgba(14,165,233,0.1); border: 1px solid rgba(14,165,233,0.25); color: #7dd3fc; }
  .alert-warn { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.25); color: #fcd34d; }
  .alert-success { background: rgba(0,212,170,0.1); border: 1px solid rgba(0,212,170,0.25); color: var(--accent); }
  
  .not-found {
    background: rgba(239,68,68,0.06);
    border: 1px dashed rgba(239,68,68,0.25);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    font-size: 0.8rem;
    color: #fca5a5;
  }
  
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .tab {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-dim);
    transition: all 0.2s;
    font-family: 'Sora', sans-serif;
  }
  .tab.active { background: var(--accent); color: #0a0e1a; border-color: var(--accent); font-weight: 600; }
  
  .spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  
  .section-gap { margin-bottom: 2.5rem; }
  
  .price-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 0.5rem; }
  .price-item { background: var(--surface2); border-radius: 6px; padding: 0.5rem 0.75rem; }
  .price-item-label { font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .price-item-val { font-weight: 600; color: var(--accent3); font-size: 0.9rem; }
  
  .loc-info { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1rem; }
  
  input[type="file"] { display: none; }
  
  .divider { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
  
  .brands { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
  .brand-tag {
    background: var(--surface2);
    border: 1px solid var(--border);
    padding: 0.2rem 0.55rem;
    border-radius: 4px;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .fade-in { animation: fadeIn 0.4s ease forwards; }
  
  .map-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.9rem;
    background: rgba(14,165,233,0.12);
    border: 1px solid rgba(14,165,233,0.3);
    color: var(--accent2);
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    text-decoration: none;
    transition: all 0.2s;
  }
  .map-btn:hover { background: rgba(14,165,233,0.22); }
  
  .rating { display: flex; align-items: center; gap: 0.25rem; font-size: 0.75rem; }
  .rating-star { color: var(--accent3); }
`;

// ============================================================
// COMPONENTS
// ============================================================

function DeliveryLinks({ links, medicineName }) {
  const encoded = encodeURIComponent(medicineName);
  return (
    <div className="delivery-links">
      <a href={links?.pharmeasy || `https://pharmeasy.in/search/all?name=${encoded}`} target="_blank" rel="noopener noreferrer" className="delivery-btn pharmeasy">💜 PharmEasy</a>
      <a href={links?.netmeds || `https://www.netmeds.com/catalogsearch/result?q=${encoded}`} target="_blank" rel="noopener noreferrer" className="delivery-btn netmeds">💚 Netmeds</a>
      <a href={links?.apollo || `https://www.apollopharmacy.in/search-medicines/${encoded}`} target="_blank" rel="noopener noreferrer" className="delivery-btn apollo-ph">🔵 Apollo</a>
      <a href={links?.onemg || `https://www.1mg.com/search/all?name=${encoded}`} target="_blank" rel="noopener noreferrer" className="delivery-btn onemg">❤️ 1mg</a>
    </div>
  );
}

function MedicineCard({ med, dbData }) {
  const lowestPrice = dbData ? getLowestPrice(dbData.average_price) : null;
  return (
    <div className="medicine-card fade-in">
      <div className="med-header">
        <div>
          <div className="med-name">{med.name}</div>
          {dbData && <div className="med-generic">{dbData.generic_name}</div>}
          {dbData && <div style={{ marginTop: "0.5rem" }}><span className="tag tag-blue">{dbData.category}</span></div>}
        </div>
        {!dbData && <span className="tag tag-amber">Not in DB</span>}
      </div>
      <div className="med-body">
        <div className="info-row">
          <span className="info-label">Dosage</span>
          <span className="info-value">{med.dosage || "—"}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Frequency</span>
          <span className="info-value">{med.frequency || "—"}</span>
        </div>
        <div className="info-row">
          <span className="info-label">Duration</span>
          <span className="info-value">{med.duration || "—"}</span>
        </div>
        {med.instructions && (
          <div className="info-row">
            <span className="info-label">Instructions</span>
            <span className="info-value" style={{ color: "var(--accent3)", maxWidth: "60%", textAlign: "right" }}>{med.instructions}</span>
          </div>
        )}

        {dbData && (
          <>
            <div className="price-box">
              <div className="price-label">Starting from</div>
              <div className="price-main">₹{lowestPrice}</div>
              <div className="price-grid" style={{ marginTop: "0.5rem" }}>
                {Object.entries(dbData.average_price).map(([k, v]) => (
                  <div className="price-item" key={k}>
                    <div className="price-item-label">{k.replace("_", " ")}</div>
                    <div className="price-item-val">₹{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="brands">
              {dbData.brand_names.map(b => <span className="brand-tag" key={b}>{b}</span>)}
            </div>
            <div style={{ marginTop: "0.75rem", fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: "0.25rem" }}>🚚 Order Online</div>
            <DeliveryLinks links={dbData.delivery_links} medicineName={dbData.generic_name} />
          </>
        )}
        {!dbData && (
          <>
            <div style={{ marginTop: "0.75rem", fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: "0.25rem" }}>🚚 Order Online</div>
            <DeliveryLinks links={null} medicineName={med.name} />
          </>
        )}
      </div>
    </div>
  );
}

function PharmacyCard({ pharmacy, selected, onClick, userLat, userLng }) {
  const chainClass = {
    Apollo: "chain-apollo",
    MedPlus: "chain-medplus",
    Wellness: "chain-wellness",
    Independent: "chain-independent"
  }[pharmacy.chain] || "chain-independent";

  const chainEmoji = {
    Apollo: "A+",
    MedPlus: "M+",
    Wellness: "W+",
    Independent: "Rx"
  }[pharmacy.chain] || "Rx";

  return (
    <div className={`pharmacy-card ${selected ? "selected" : ""}`} onClick={() => onClick(pharmacy)}>
      <div className={`chain-badge ${chainClass}`}>{chainEmoji}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="ph-name">{pharmacy.name}</div>
        <div className="ph-address">{pharmacy.address}</div>
        <div className="ph-meta">
          {pharmacy.rating && (
            <span className="rating">
              <span className="rating-star">★</span>
              <span>{pharmacy.rating}</span>
            </span>
          )}
          <span className="tag tag-blue">{pharmacy.distance} km</span>
          <span className={`tag ${pharmacy.open_now === false ? "tag-red" : "tag-green"}`}>
            {pharmacy.open_now === false ? "Closed" : "Open"}
          </span>
        </div>
        <div style={{ marginTop: "0.5rem" }}>
          <a href={pharmacy.maps_url} target="_blank" rel="noopener noreferrer" className="map-btn" onClick={e => e.stopPropagation()}>
            🗺️ Navigate
          </a>
        </div>
      </div>
    </div>
  );
}

function DoctorCard({ doctor }) {
  if (!doctor || !doctor.name) return null;
  return (
    <div className="doctor-card fade-in">
      <div className="doc-avatar">👨‍⚕️</div>
      <div style={{ flex: 1 }}>
        <div className="doc-name">{doctor.name}</div>
        {doctor.specialization && <div className="doc-spec">{doctor.specialization}</div>}
        {doctor.clinic && <div className="doc-info">🏥 {doctor.clinic}</div>}
        {doctor.address && <div className="doc-info">📍 {doctor.address}</div>}
        {doctor.phone && (
          <div className="doc-info">
            📞 <a href={`tel:${doctor.phone}`} style={{ color: "var(--accent)", textDecoration: "none" }}>{doctor.phone}</a>
          </div>
        )}
        {doctor.registration && <div className="doc-info" style={{ fontSize: "0.7rem" }}>🪪 Reg: {doctor.registration}</div>}
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [step, setStep] = useState("upload"); // upload | processing | results
  const [dragging, setDragging] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [imageMime, setImageMime] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [pharmacies, setPharmacies] = useState([]);
  const [selectedPharmacy, setSelectedPharmacy] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locationStatus, setLocationStatus] = useState("idle"); // idle | loading | done | error
  const [processingMsg, setProcessingMsg] = useState("");
  const [activeTab, setActiveTab] = useState("medicines");
  const fileRef = useRef();

  // Get location on mount
  useEffect(() => {
    setLocationStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationStatus("done");
      },
      () => {
        // Default to Hyderabad center
        setUserLocation({ lat: 17.4065, lng: 78.4772 });
        setLocationStatus("error");
      },
      { timeout: 8000 }
    );
  }, []);

  // Fetch pharmacies when location is available
  useEffect(() => {
    if (userLocation) {
      const fetchStores = async () => {
        try {
          const stores = await searchNearbyPharmacies(userLocation.lat, userLocation.lng);
          setPharmacies(stores);
          if (stores.length > 0) setSelectedPharmacy(stores[0]);
        } catch (err) {
          console.error("Failed to fetch pharmacies:", err);
        }
      };
      fetchStores();
    }
  }, [userLocation]);

  const processFile = (file) => {
    if (!file || !file.type.startsWith("image/")) {
      alert("Please upload an image file (JPG, PNG, WEBP, etc.)");
      return;
    }
    setImageFile(file);
    setImageMime(file.type);
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      setImagePreview(dataUrl);
      const b64 = dataUrl.split(",")[1];
      setImageBase64(b64);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    processFile(file);
  };

  const handleAnalyze = async () => {
    if (!imageBase64) return;
    setStep("processing");

    try {
      setProcessingMsg("Initializing AI analysis...");
      const data = await extractMedicinesFromPrescription(imageBase64, imageMime, (msg) => setProcessingMsg(`🔍 ${msg}`));
      setExtractedData(data);

      setProcessingMsg("📍 Finding nearby pharmacies...");
      if (userLocation) {
        const stores = await searchNearbyPharmacies(userLocation.lat, userLocation.lng);
        setPharmacies(stores);
        if (stores.length > 0) setSelectedPharmacy(stores[0]);
      }

      setStep("results");
    } catch (err) {
      console.error(err);
      alert("Error analyzing prescription: " + err.message);
      setStep("upload");
    }
  };

  const reset = () => {
    setStep("upload");
    setImageFile(null);
    setImagePreview(null);
    setImageBase64(null);
    setExtractedData(null);
    setPharmacies([]);
    setSelectedPharmacy(null);
    setActiveTab("medicines");
  };

  const mapSrc = selectedPharmacy
    ? `https://maps.google.com/maps?q=${selectedPharmacy.lat},${selectedPharmacy.lng}&z=15&output=embed`
    : userLocation
      ? `https://maps.google.com/maps?q=${userLocation.lat},${userLocation.lng}&z=14&output=embed`
      : null;

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <header className="header">
          <div className="header-logo">🛡️</div>
          <div>
            <div className="header-title">MEDSCAN</div>
            <div className="header-sub">Smart Prescription Analytics</div>
          </div>
          <span className="badge">GLOBAL • 2026</span>
        </header>

        <main className="main">
          {/* Step Indicator */}
          <div className="step-indicator">
            {[
              { key: "upload", label: "Upload Rx" },
              { key: "processing", label: "AI Extraction" },
              { key: "results", label: "Medicines + Stores" }
            ].map((s, i, arr) => (
              <>
                <div key={s.key} className={`step ${step === s.key ? "active" : (["processing", "results"].indexOf(step) > ["processing", "results"].indexOf(s.key) || (step === "results" && s.key !== "results")) ? "done" : ""}`}>
                  <div className="step-dot">{i + 1}</div>
                  <span>{s.label}</span>
                </div>
                {i < arr.length - 1 && <div className="step-line" key={`l${i}`} />}
              </>
            ))}
          </div>

          {/* UPLOAD STEP */}
          {step === "upload" && (
            <div className="fade-in">
              {locationStatus === "done" && (
                <div className="loc-info">
                  <span>📍</span>
                  <span>Location detected — will find pharmacies near you</span>
                  <span className="tag tag-green" style={{ marginLeft: "auto" }}>GPS Active</span>
                </div>
              )}
              {locationStatus === "error" && (
                <div className="alert alert-warn" style={{ marginBottom: "1rem" }}>
                  ⚠️ Location access denied. Using Hyderabad city center as default.
                </div>
              )}

              <div
                className={`upload-zone ${dragging ? "drag-over" : ""}`}
                onClick={() => fileRef.current.click()}
                onDrop={handleDrop}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
              >
                <input ref={fileRef} type="file" accept="image/*" onChange={e => processFile(e.target.files[0])} />
                {imagePreview ? (
                  <img src={imagePreview} alt="Prescription preview" className="preview-img" />
                ) : (
                  <>
                    <div className="upload-icon">📋</div>
                    <div className="upload-title">Upload Prescription</div>
                    <div className="upload-sub">Drop your prescription image here or click to browse</div>
                    <div className="upload-sub" style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>Supports JPG, PNG, WEBP • AI-Powered Vision Analysis</div>
                  </>
                )}
              </div>

              {imagePreview && (
                <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", justifyContent: "center" }}>
                  <button className="btn btn-outline" onClick={() => { setImageFile(null); setImagePreview(null); setImageBase64(null); }}>Clear</button>
                  <button className="btn btn-primary" onClick={handleAnalyze} disabled={!imageBase64}>
                    <span>🔍</span> Analyze Prescription
                  </button>
                </div>
              )}

              <div className="alert alert-info" style={{ marginTop: "1.5rem" }}>
                ℹ️ Your prescription is analyzed by a Vision Language Model (Gemini / Llama Vision) to extract medicine names, dosages, and doctor details. No data is stored.
              </div>

              {/* Nearby Stores on Landing Page */}
              {pharmacies.length > 0 && (
                <div className="fade-in" style={{ marginTop: "2.5rem" }}>
                  <div className="section-header">
                    <div className="section-title">🏪 Nearby Pharmacies</div>
                    <div className="section-pill">{pharmacies.length} Stores Found</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    {pharmacies.slice(0, 4).map(ph => (
                      <PharmacyCard
                        key={ph.id}
                        pharmacy={ph}
                        selected={selectedPharmacy?.id === ph.id}
                        onClick={(p) => { 
                          setSelectedPharmacy(p);
                          setStep("results");
                          setActiveTab("map");
                        }}
                        userLat={userLocation?.lat}
                        userLng={userLocation?.lng}
                      />
                    ))}
                  </div>
                  {pharmacies.length > 4 && (
                    <button 
                      className="btn btn-ghost btn-sm" 
                      style={{ marginTop: "1rem", width: "100%", justifyContent: "center" }}
                      onClick={() => {
                        setStep("results");
                        setActiveTab("stores");
                      }}
                    >
                      View All {pharmacies.length} Stores nearby →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* PROCESSING STEP */}
          {step === "processing" && (
            <div className="fade-in" style={{ textAlign: "center", padding: "4rem 2rem" }}>
              <div style={{ fontSize: "3rem", marginBottom: "1.5rem" }}>⚕️</div>
              <div style={{ fontWeight: 600, fontSize: "1.1rem", marginBottom: "0.75rem" }}>{processingMsg}</div>
              <div style={{ maxWidth: "300px", margin: "0 auto" }}>
                <div className="loading-bar"><div className="loading-fill" /></div>
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: "0.8rem", marginTop: "1rem" }}>
                AI Vision Analysis • Finding stores near you
              </div>
            </div>
          )}

          {/* RESULTS STEP */}
          {step === "results" && (
            <div className="fade-in">
              <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn btn-outline btn-sm" onClick={reset}>← New Prescription</button>
                {extractedData?.diagnosis && (
                  <span className="tag tag-amber">🏥 {extractedData.diagnosis}</span>
                )}
                {extractedData?.patient?.date && (
                  <span className="tag tag-blue">📅 {extractedData.patient.date}</span>
                )}
                {extractedData?.medicines?.length > 0 && (
                  <span className="tag tag-green">💊 {extractedData.medicines.length} medicines found</span>
                )}
                {!extractedData && (
                  <span className="tag tag-blue">📍 Store View Mode</span>
                )}
              </div>

              <div className="tabs">
                {[
                  { id: "medicines", label: `💊 Medicines (${extractedData?.medicines?.length || 0})` },
                  { id: "stores", label: `🏪 Nearby Stores (${pharmacies.length})` },
                  { id: "map", label: "🗺️ Map" },
                  { id: "doctor", label: "👨‍⚕️ Doctor" },
                  { id: "consult", label: "📱 Consult Online" }
                ].map(t => (
                  <button key={t.id} className={`tab ${activeTab === t.id ? "active" : ""}`} onClick={() => setActiveTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* MEDICINES TAB */}
              {activeTab === "medicines" && (
                <div className="section-gap">
                  {(!extractedData || extractedData.medicines?.length === 0) && (
                    <div className="alert alert-warn">No medicines found. Please upload and analyze a prescription first.</div>
                  )}
                  <div className="grid-2">
                    {extractedData?.medicines?.map((med, i) => {
                      const dbData = lookupMedicine(med.name);
                      return <MedicineCard key={i} med={med} dbData={dbData} />;
                    })}
                  </div>
                  {extractedData?.medicines?.length > 0 && (
                    <div className="alert alert-info" style={{ marginTop: "1rem" }}>
                      ℹ️ Prices shown are approximate market rates. Actual prices may vary by pharmacy. Always consult your doctor before substituting medicines.
                    </div>
                  )}
                </div>
              )}

              {/* STORES TAB */}
              {activeTab === "stores" && (
                <div className="section-gap">
                  <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
                    📍 Showing pharmacies {locationStatus === "done" ? "near your location" : "near you"} — sorted by distance
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    {pharmacies.map(ph => (
                      <PharmacyCard
                        key={ph.id}
                        pharmacy={ph}
                        selected={selectedPharmacy?.id === ph.id}
                        onClick={(p) => { setSelectedPharmacy(p); setActiveTab("map"); }}
                        userLat={userLocation?.lat}
                        userLng={userLocation?.lng}
                      />
                    ))}
                  </div>
                  <div className="alert alert-warn" style={{ marginTop: "1rem" }}>
                    ⚠️ Call ahead to confirm medicine availability before visiting. Stock may vary.
                  </div>
                </div>
              )}

              {/* MAP TAB */}
              {activeTab === "map" && (
                <div className="section-gap">
                  {selectedPharmacy && (
                    <div className="alert alert-success" style={{ marginBottom: "0.75rem" }}>
                      📍 Showing: <strong>{selectedPharmacy.name}</strong> — {selectedPharmacy.distance} km away
                      &nbsp;<a href={selectedPharmacy.maps_url} target="_blank" rel="noopener noreferrer" className="map-btn" style={{ marginLeft: "0.5rem" }}>Open in Google Maps</a>
                    </div>
                  )}
                  <div className="map-container">
                    {mapSrc ? (
                      <iframe
                        className="map-frame"
                        src={mapSrc}
                        allowFullScreen
                        referrerPolicy="no-referrer-when-downgrade"
                        title="Pharmacy Map"
                      />
                    ) : (
                      <div className="map-placeholder">
                        <div style={{ fontSize: "2rem" }}>🗺️</div>
                        <div>Map loading...</div>
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: "1rem" }}>
                    <div className="section-header">
                      <span className="section-title">Select Pharmacy</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                      {pharmacies.map(ph => (
                        <div
                          key={ph.id}
                          style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.9rem", background: selectedPharmacy?.id === ph.id ? "rgba(14,165,233,0.08)" : "var(--surface)", border: `1px solid ${selectedPharmacy?.id === ph.id ? "var(--accent2)" : "var(--border)"}`, borderRadius: "8px", cursor: "pointer" }}
                          onClick={() => setSelectedPharmacy(ph)}
                        >
                          <span style={{ fontSize: "0.85rem", fontWeight: selectedPharmacy?.id === ph.id ? 600 : 400 }}>{ph.name}</span>
                          <span className="tag tag-blue" style={{ marginLeft: "auto", flexShrink: 0 }}>{ph.distance} km</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* DOCTOR TAB */}
              {activeTab === "doctor" && (
                <div className="section-gap">
                  {extractedData?.doctor?.name ? (
                    <>
                      <DoctorCard doctor={extractedData.doctor} />
                      {extractedData.doctor.phone && (
                        <div className="alert alert-success" style={{ marginTop: "1rem" }}>
                          📞 Doctor contact available from prescription. Always verify with clinic before calling.
                        </div>
                      )}
                      {!extractedData.doctor.phone && (
                        <div className="alert alert-warn" style={{ marginTop: "1rem" }}>
                          ℹ️ Phone number not found on prescription. Try searching the clinic name online or use consultation platforms below.
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="alert alert-warn">
                      No doctor information found in prescription. Upload a clearer image or use online consultation platforms.
                    </div>
                  )}

                  {extractedData?.patient && (extractedData.patient.name || extractedData.patient.age) && (
                    <div className="card" style={{ marginTop: "1rem" }}>
                      <div style={{ fontWeight: 600, marginBottom: "0.75rem", color: "var(--text-dim)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>Patient Details</div>
                      {extractedData.patient.name && <div className="info-row"><span className="info-label">Name</span><span className="info-value">{extractedData.patient.name}</span></div>}
                      {extractedData.patient.age && <div className="info-row"><span className="info-label">Age</span><span className="info-value">{extractedData.patient.age}</span></div>}
                      {extractedData.patient.date && <div className="info-row"><span className="info-label">Date</span><span className="info-value">{extractedData.patient.date}</span></div>}
                    </div>
                  )}
                </div>
              )}

              {/* CONSULT TAB */}
              {activeTab === "consult" && (
                <div className="section-gap">
                  <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
                    💡 Can't reach your doctor? Consult a verified doctor online
                  </div>
                  <div className="grid-2">
                    {MEDICINE_DB.consultation_platforms.map(p => (
                      <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="consult-card">
                        <div className="consult-icon">{p.logo}</div>
                        <div>
                          <div className="consult-name">{p.name}</div>
                          <div className="consult-desc">{p.description}</div>
                        </div>
                        <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "1rem" }}>→</span>
                      </a>
                    ))}
                  </div>
                  <div className="card" style={{ marginTop: "1.25rem" }}>
                    <div style={{ fontWeight: 600, marginBottom: "0.75rem" }}>🚑 Emergency Contacts</div>
                    {[
                      { label: "Ambulance (108)", val: "108" },
                      { label: "Emergency", val: "112" },
                      { label: "NIMS Hospital", val: "040-23489000" },
                      { label: "Apollo Hospitals (Banjara Hills)", val: "040-23607777" },
                      { label: "Yashoda Hospital (Somajiguda)", val: "040-45674567" }
                    ].map(item => (
                      <div className="info-row" key={item.label}>
                        <span className="info-label">{item.label}</span>
                        <a href={`tel:${item.val}`} style={{ color: "var(--accent)", fontWeight: 600, fontSize: "0.85rem", textDecoration: "none" }}>{item.val}</a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </>
  );
}
