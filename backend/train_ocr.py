# Imports and Installs
!pip install torch torchvision torchaudio transformers pytorch-lightning sentencepiece Pillow --quiet
!pip install albumentations[imgaug] --quiet

import os
import json
from PIL import Image
import random
import torch
from torch.utils.data import Dataset, DataLoader
import pytorch_lightning as pl
from transformers import DonutProcessor, VisionEncoderDecoderModel, AdamW, get_scheduler
from pytorch_lightning.callbacks import EarlyStopping, ModelCheckpoint
from pytorch_lightning.utilities import rank_zero_only
from tqdm import tqdm
import numpy as np

import torch
torch.set_float32_matmul_precision('medium')


# --------

# Paths and Hyperparameters

data_root = "/teamspace/studios/this_studio"

train_images_dir = os.path.join(data_root, 'train', 'images')
train_annotations_dir = os.path.join(data_root, 'train', 'annotations')

val_images_dir = os.path.join(data_root, 'val', 'images')
val_annotations_dir = os.path.join(data_root, 'val', 'annotations')

test_images_dir = os.path.join(data_root, 'test', 'images')
test_annotations_dir = os.path.join(data_root, 'test', 'annotations')

splits_dir = os.path.join(data_root, 'splits')
train_split_file = os.path.join(splits_dir, 'train.txt')
val_split_file = os.path.join(splits_dir, 'val.txt')
test_split_file = os.path.join(splits_dir, 'test.txt')

save_dir = os.path.join(data_root, 'donut_trained_model')
os.makedirs(save_dir, exist_ok=True)

# Hyperparameters
learning_rate = 3e-5
weight_decay = 0.001
max_epochs = 30
warmup_ratio = 0.05
batch_size = 2
num_workers = 4
max_length = 512
precision = 16

# --------

# Dataset and Collation (Gradual Augmentation)

from albumentations import (
    Compose, Rotate, RandomBrightnessContrast, GaussNoise, Blur, ShiftScaleRotate, 
    MotionBlur, Downscale, RandomFog, RandomShadow, Perspective
)
from albumentations.pytorch import ToTensorV2

def get_basic_augmentations():
    # Lighter augmentations for initial training epochs
    return Compose([
        ShiftScaleRotate(shift_limit=0.05, scale_limit=0.05, rotate_limit=5, p=0.5),
        RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0.2, p=0.5),
        GaussNoise(var_limit=(10.0, 50.0), p=0.3),
        Blur(blur_limit=3, p=0.3),
        ToTensorV2()
    ])

def get_advanced_augmentations():
    # Heavier augmentations for later epochs
    return Compose([
        ShiftScaleRotate(shift_limit=0.1, scale_limit=0.1, rotate_limit=10, p=0.7),
        RandomBrightnessContrast(brightness_limit=0.4, contrast_limit=0.4, p=0.7),
        GaussNoise(var_limit=(10.0, 100.0), p=0.5),
        Blur(blur_limit=5, p=0.5),
        MotionBlur(blur_limit=5, p=0.5),
        Downscale(scale_min=0.5, scale_max=0.9, p=0.4),
        RandomFog(fog_coef_lower=0.1, fog_coef_upper=0.3, alpha_coef=0.1, p=0.3),
        RandomShadow(shadow_roi=(0,0,1,1), num_shadows_lower=1, num_shadows_upper=2, shadow_dimension=3, p=0.3),
        Perspective(scale=(0.05,0.1), keep_size=True, p=0.5),
        ToTensorV2()
    ])

class DocumentDataset(Dataset):
    def __init__(self, images_dir, annotations_dir, split_file, processor, max_length=512, augmentations=None):
        with open(split_file, 'r') as f:
            self.filenames = [line.strip() for line in f]
        self.images_dir = images_dir
        self.annotations_dir = annotations_dir
        self.processor = processor
        self.max_length = max_length
        # Will start with basic and later switch to advanced
        self.augmentations = augmentations

    def __len__(self):
        return len(self.filenames)

    def __getitem__(self, idx):
        filename = self.filenames[idx]
        image_path = os.path.join(self.images_dir, filename)
        annotation_path = os.path.join(self.annotations_dir, f"{os.path.splitext(filename)[0]}.json")

        image = Image.open(image_path).convert("RGB")
        with open(annotation_path, 'r') as f:
            annotation = json.load(f)
        target_text = annotation['gt_text']['text_sequence']

        if self.augmentations:
            image_np = np.array(image)
            augmented = self.augmentations(image=image_np)
            image_tensor = augmented["image"]
        else:
            image_tensor = None

        if image_tensor is None:
            encoding = self.processor(
                images=image,
                text=target_text,
                return_tensors="pt",
                padding="max_length",
                max_length=self.max_length,
                truncation=True,
                add_special_tokens=True
            )
        else:
            image_pil = Image.fromarray(image_tensor.permute(1,2,0).cpu().numpy().astype(np.uint8))
            encoding = self.processor(
                images=image_pil,
                text=target_text,
                return_tensors="pt",
                padding="max_length",
                max_length=self.max_length,
                truncation=True,
                add_special_tokens=True
            )

        labels = encoding.labels
        labels[labels == self.processor.tokenizer.pad_token_id] = -100
        return {"pixel_values": encoding.pixel_values.squeeze(0), "labels": labels.squeeze(0)}

def collate_fn(batch):
    pixel_values = torch.stack([item['pixel_values'] for item in batch])
    labels = torch.stack([item['labels'] for item in batch])
    return {'pixel_values': pixel_values, 'labels': labels}


# --------

# New Callback: Gradual Augmentation

class GradualAugmentationCallback(pl.Callback):
    def __init__(self, dm, switch_epoch=10):
        """
        dm: The DataModule instance.
        switch_epoch: After this epoch, switch to advanced augmentations.
        """
        super().__init__()
        self.dm = dm
        self.switch_epoch = switch_epoch

    def on_train_epoch_end(self, trainer, pl_module):
        current_epoch = trainer.current_epoch
        if current_epoch + 1 == self.switch_epoch:
            print(f"Switching to advanced augmentations at epoch {current_epoch+1}")
            self.dm.train_dataset.augmentations = get_advanced_augmentations()


# --------

# DataModule (Initialization of Basic Augs)

class DonutDataModule(pl.LightningDataModule):
    def __init__(self, processor,
                 train_images_dir, train_annotations_dir, train_split_file,
                 val_images_dir, val_annotations_dir, val_split_file,
                 test_images_dir, test_annotations_dir, test_split_file,
                 batch_size=4, num_workers=4, max_length=512):
        super().__init__()
        self.processor = processor
        self.train_images_dir = train_images_dir
        self.train_annotations_dir = train_annotations_dir
        self.train_split_file = train_split_file
        self.val_images_dir = val_images_dir
        self.val_annotations_dir = val_annotations_dir
        self.val_split_file = val_split_file
        self.test_images_dir = test_images_dir
        self.test_annotations_dir = test_annotations_dir
        self.test_split_file = test_split_file
        self.batch_size = batch_size
        self.num_workers = num_workers
        self.max_length = max_length

        # Start with basic augmentations
        self.train_augmentations = get_basic_augmentations()

    def setup(self, stage=None):
        self.train_dataset = DocumentDataset(
            self.train_images_dir, self.train_annotations_dir, self.train_split_file,
            self.processor, self.max_length, augmentations=self.train_augmentations
        )
        self.val_dataset = DocumentDataset(
            self.val_images_dir, self.val_annotations_dir, self.val_split_file,
            self.processor, self.max_length, augmentations=None
        )
        self.test_dataset = DocumentDataset(
            self.test_images_dir, self.test_annotations_dir, self.test_split_file,
            self.processor, self.max_length, augmentations=None
        )

    def train_dataloader(self):
        return DataLoader(self.train_dataset, batch_size=self.batch_size, shuffle=True,
                          num_workers=self.num_workers, collate_fn=collate_fn, pin_memory=True)

    def val_dataloader(self):
        return DataLoader(self.val_dataset, batch_size=self.batch_size, shuffle=False,
                          num_workers=self.num_workers, collate_fn=collate_fn, pin_memory=True)

    def test_dataloader(self):
        return DataLoader(self.test_dataset, batch_size=self.batch_size, shuffle=False,
                          num_workers=self.num_workers, collate_fn=collate_fn, pin_memory=True)


# --------

# Lightning Module (Adjusting configure_optimizers and add_special_tokens already done in dataset)

class DonutModelModule(pl.LightningModule):
    def __init__(self, processor, learning_rate=1e-5, weight_decay=0.01, num_training_steps=10000, warmup_steps=1000):
        super().__init__()
        self.save_hyperparameters()
        self.processor = processor
        self.model = VisionEncoderDecoderModel.from_pretrained("naver-clova-ix/donut-base")

        # Configuring special tokens
        task_prompt = "<s_ocr>"
        eos_token = "</s>"
        special_tokens = {'additional_special_tokens': [task_prompt, eos_token]}
        self.processor.tokenizer.add_special_tokens(special_tokens)
        self.model.decoder.resize_token_embeddings(len(self.processor.tokenizer))
        self.processor.tokenizer.pad_token = self.processor.tokenizer.eos_token

        self.model.config.decoder_start_token_id = self.processor.tokenizer.convert_tokens_to_ids(task_prompt)
        self.model.config.eos_token_id = self.processor.tokenizer.convert_tokens_to_ids(eos_token)
        self.model.config.pad_token_id = self.processor.tokenizer.pad_token_id

        # Enabling gradient checkpointing
        self.model.gradient_checkpointing_enable()

    def forward(self, pixel_values, labels):
        return self.model(pixel_values=pixel_values, labels=labels)

    def training_step(self, batch, batch_idx):
        outputs = self(pixel_values=batch["pixel_values"], labels=batch["labels"])
        loss = outputs.loss
        self.log("train_loss", loss, prog_bar=True, logger=True)
        return loss

    def validation_step(self, batch, batch_idx):
        self.model.eval()
        with torch.no_grad():
            outputs = self(pixel_values=batch["pixel_values"], labels=batch["labels"])
            val_loss = outputs.loss
        self.log("val_loss", val_loss, prog_bar=True, logger=True)
        return val_loss

    def configure_optimizers(self):
        optimizer = AdamW(self.parameters(), lr=self.hparams.learning_rate, weight_decay=self.hparams.weight_decay)
        lr_scheduler = get_scheduler(
            "linear",
            optimizer=optimizer,
            num_warmup_steps=self.hparams.warmup_steps,
            num_training_steps=self.hparams.num_training_steps
        )
        return {
            "optimizer": optimizer,
            "lr_scheduler": {
                "scheduler": lr_scheduler,
                "interval": "step",
                "frequency": 1
            }
        }


# --------

# Training, Testing, and Saving

processor = DonutProcessor.from_pretrained("naver-clova-ix/donut-base")

dm = DonutDataModule(
    processor=processor,
    train_images_dir=train_images_dir,
    train_annotations_dir=train_annotations_dir,
    train_split_file=train_split_file,
    val_images_dir=val_images_dir,
    val_annotations_dir=val_annotations_dir,
    val_split_file=val_split_file,
    test_images_dir=test_images_dir,
    test_annotations_dir=test_annotations_dir,
    test_split_file=test_split_file,
    batch_size=batch_size,
    num_workers=num_workers,
    max_length=max_length
)

dm.setup()
steps_per_epoch = len(dm.train_dataloader())
total_steps = steps_per_epoch * max_epochs
warmup_steps = int(warmup_ratio * total_steps)

model_module = DonutModelModule(
    processor=processor,
    learning_rate=learning_rate,
    weight_decay=weight_decay,
    num_training_steps=total_steps,
    warmup_steps=warmup_steps
)

checkpoint_callback = ModelCheckpoint(
    dirpath=save_dir,
    filename="donut-best-checkpoint",
    monitor="val_loss",
    mode="min",
    save_top_k=1
)

early_stopping_callback = EarlyStopping(
    monitor="val_loss",
    patience=10,
    mode="min",
    verbose=True
)

# Gradual Augmentation Callback to switch at epoch 10
gradual_callback = GradualAugmentationCallback(dm, switch_epoch=10)

trainer = pl.Trainer(
    max_epochs=max_epochs,
    accelerator="gpu" if torch.cuda.is_available() else "cpu",
    devices=1,
    precision=precision,
    gradient_clip_val=1.0,
    callbacks=[checkpoint_callback, early_stopping_callback, gradual_callback],
    log_every_n_steps=50
)

trainer.fit(model_module, datamodule=dm)

best_model_path = checkpoint_callback.best_model_path
print(f"Best model saved at {best_model_path}")
model_module = DonutModelModule.load_from_checkpoint(best_model_path, processor=processor)
model_module.eval()


# --------

# Testing and Evaluation

def compute_accuracies(predictions, references):
    # Character-level accuracy
    total_chars = 0
    correct_chars = 0

    # Word-level accuracy
    total_words = 0
    correct_words = 0

    for pred, ref in zip(predictions, references):
        # Character accuracy
        pred_chars = list(pred)
        ref_chars = list(ref)
        total_chars += len(ref_chars)
        correct_chars += sum(p == r for p, r in zip(pred_chars, ref_chars))

        # Word accuracy
        pred_words = pred.split()
        ref_words = ref.split()
        total_words += len(ref_words)
        correct_words += sum(pw == rw for pw, rw in zip(pred_words, ref_words))

    char_acc = correct_chars / total_chars if total_chars > 0 else 0
    word_acc = correct_words / total_words if total_words > 0 else 0
    return char_acc, word_acc

# Run inference on test set
test_loader = dm.test_dataloader()

predictions = []
references = []

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model_module.to(device)

model_module.model.eval()
with torch.no_grad():
    for batch in tqdm(test_loader, desc="Testing"):
        pixel_values = batch["pixel_values"].to(device)
        labels = batch["labels"]

        # Generate predictions
        outputs = model_module.model.generate(
            pixel_values, 
            max_length=512,
            num_beams=1,
            early_stopping=True,
            decoder_start_token_id=model_module.processor.tokenizer.convert_tokens_to_ids("<s_ocr>")
        )

        batch_predictions = model_module.processor.batch_decode(outputs, skip_special_tokens=True)
        # Clean predictions (remove task prompt and eos token if needed)
        batch_predictions = [
            pred.replace("<s_ocr>", "").replace("</s>", "").strip()
            for pred in batch_predictions
        ]

        # Get references
        for i, label in enumerate(labels):
            # Convert labels back to text
            text = model_module.processor.tokenizer.decode(
                [l for l in label.tolist() if l != -100 and l != model_module.processor.tokenizer.pad_token_id], 
                skip_special_tokens=True
            )
            text = text.replace("<s_ocr>", "").replace("</s>", "").strip()
            references.append(text)

        predictions.extend(batch_predictions)

char_acc, word_acc = compute_accuracies(predictions, references)

print("Character-level Accuracy: {:.2f}%".format(char_acc * 100))
print("Word-level Accuracy: {:.2f}%".format(word_acc * 100))

# Print a few samples
for i in range(min(3, len(predictions))):
    print("Reference:", references[i])
    print("Prediction:", predictions[i])
    print("-"*50)


# --------

# Save the final model and processor

final_save_dir = os.path.join(data_root, "final_donut2")
os.makedirs(final_save_dir, exist_ok=True)
model_module.model.save_pretrained(final_save_dir)
processor.save_pretrained(final_save_dir)

print("Model and processor saved successfully!")
