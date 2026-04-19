import os
import io
import json
import base64
import torch
import uvicorn
from datetime import datetime
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image
from transformers import VisionEncoderDecoderModel, DonutProcessor

app = FastAPI(title="Local OCR Backend")

# Enable CORS for frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_REPO = "chinmays18/medical-prescription-ocr"
DB_PATH = "jsondb.json"

def save_to_db(record):
    """Appends a new record to the JSON database file."""
    try:
        data = []
        if os.path.exists(DB_PATH):
            with open(DB_PATH, "r", encoding="utf-8") as f:
                try:
                    data = json.load(f)
                except json.JSONDecodeError:
                    data = []
        
        data.append(record)
        
        with open(DB_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        print(f"Record successfully saved to {DB_PATH}")
    except Exception as e:
        print(f"Failed to save record to {DB_PATH}: {e}")

print("Loading processor and model... This might take a minute on first run.")
try:
    processor = DonutProcessor.from_pretrained(MODEL_REPO)
    model = VisionEncoderDecoderModel.from_pretrained(MODEL_REPO)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    model.eval()
    print(f"Model loaded successfully on {device}")
except Exception as e:
    print(f"Failed to load model: {e}")

class OCRRequest(BaseModel):
    image_base64: str
    mime_type: str

@app.post("/api/local-ocr/predict")
async def predict_ocr(req: OCRRequest):
    try:
        # Decode base64 image
        if "," in req.image_base64:
            b64_data = req.image_base64.split(",")[1]
        else:
            b64_data = req.image_base64
            
        image_data = base64.b64decode(b64_data)
        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        
        # Preprocess
        pixel_values = processor(images=image, return_tensors="pt").pixel_values.to(device)
        
        # Build prompt
        task_prompt = "<s_ocr>"
        decoder_input_ids = processor.tokenizer(task_prompt, return_tensors="pt").input_ids.to(device)
        
        # Generate
        with torch.no_grad():
            generated_ids = model.generate(
                pixel_values,
                decoder_input_ids=decoder_input_ids,
                max_length=512,
                num_beams=1,
                early_stopping=True,
                pad_token_id=processor.tokenizer.pad_token_id,
                eos_token_id=processor.tokenizer.eos_token_id,
                decoder_start_token_id=processor.tokenizer.convert_tokens_to_ids(task_prompt)
            )
            
        # Decode target seq
        generated_text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        
        # Process output into JSON object
        # The trained Donut model generally outputs an XML-like sequence or tokenized json text.
        try:
            # Let the processor handle token to JSON map if possible
            output_json = processor.token2json(generated_text)
        except Exception:
            output_json = {"raw_text": generated_text}
        
        # Ensure our frontend standard schema so it doesn't break the UI
        final_result = {
            "medicines": [],
            "doctor": {"name": "", "specialization": "", "clinic": "", "address": "", "phone": "", "registration": ""},
            "patient": {"name": "", "age": "", "date": ""},
            "diagnosis": "",
            "_raw_local_ocr": generated_text
        }
        
        # Try a heuristic map if it contains medication arrays or dicts
        if isinstance(output_json, dict):
            # mapping heuristic
            final_result["_raw_local_ocr"] = output_json
            
            meds = output_json.get("medicines", output_json.get("drugs", []))
            if isinstance(meds, list):
                for m in meds:
                    if isinstance(m, dict):
                        final_result["medicines"].append({
                            "name": m.get("name", m.get("drug", "")),
                            "dosage": m.get("dosage", ""),
                            "frequency": m.get("frequency", ""),
                            "duration": m.get("duration", ""),
                            "instructions": m.get("instructions", "")
                        })
                    elif isinstance(m, str):
                        final_result["medicines"].append({"name": m})
                        
            doctor = output_json.get("doctor", {})
            if isinstance(doctor, dict):
                final_result["doctor"].update(doctor)
                
            patient = output_json.get("patient", {})
            if isinstance(patient, dict):
                final_result["patient"].update(patient)
                
            final_result["diagnosis"] = output_json.get("diagnosis", "")
            
        print("Generated Output:", final_result)
        
        # Save to local JSON database
        db_record = {
            "timestamp": datetime.now().isoformat(),
            "extracted_data": final_result
        }
        save_to_db(db_record)
        
        return final_result
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
