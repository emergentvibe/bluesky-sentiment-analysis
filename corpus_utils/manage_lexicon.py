import csv
import os
import argparse
import sys
import time
import anthropic # Import Anthropic library

# --- Anthropic API Client Initialization --- 
# Ensure ANTHROPIC_API_KEY is set as an environment variable
try:
    client = anthropic.Anthropic()
except anthropic.AnthropicError as e:
    print(f"Error initializing Anthropic client: {e}")
    print("Please ensure the ANTHROPIC_API_KEY environment variable is set correctly.")
    sys.exit(1)

# Configuration for LLM calls
LLM_MODEL_EMOTION = "claude-3-haiku-20240307" # Or another suitable model
LLM_MODEL_TRANSLATION = "claude-3-haiku-20240307" # Can be the same or different
LLM_MAX_RETRIES = 3
LLM_RETRY_DELAY = 5 # seconds

# --- LLM Interaction Functions (Using Anthropic) --- 

def call_anthropic_llm(prompt, model, max_tokens=10): # Reduced max_tokens for score
    """Helper function to call the Anthropic API with retries."""
    retries = 0
    while retries < LLM_MAX_RETRIES:
        try:
            message = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                messages=[
                    {
                        "role": "user",
                        "content": prompt
                    }
                ]
            )
            # Access the content of the first text block
            if message.content and isinstance(message.content, list) and len(message.content) > 0:
                 # Check if the first block is a TextBlock
                 if hasattr(message.content[0], 'text'):
                      return message.content[0].text.strip()
                 else:
                      print(f"  [LLM Warning] Unexpected content block type: {type(message.content[0])}")
                      return None # Or handle other block types if expected
            else:
                 print("  [LLM Warning] Received empty or unexpected content structure from API.")
                 return None
            
        except anthropic.APIConnectionError as e:
            print(f"  [LLM Error] Anthropic API request failed to connect: {e}")
        except anthropic.RateLimitError as e:
            print(f"  [LLM Error] Anthropic API rate limit exceeded: {e}. Retrying in {LLM_RETRY_DELAY}s...")
            time.sleep(LLM_RETRY_DELAY)
        except anthropic.APIStatusError as e:
            print(f"  [LLM Error] Anthropic API returned an error status: {e.status_code} {e.response}")
            # Don't retry on persistent status errors like 4xx
            if 400 <= e.status_code < 500:
                return None
        except Exception as e:
            print(f"  [LLM Error] An unexpected error occurred during API call: {e}")
            
        retries += 1
        if retries < LLM_MAX_RETRIES:
            print(f"    Retrying ({retries}/{LLM_MAX_RETRIES})...")
            time.sleep(LLM_RETRY_DELAY * retries) # Exponential backoff
        else:
            print("  [LLM Error] Max retries reached.")
            
    return None # Return None after exhausting retries or encountering non-retryable errors

def get_emotion_score_from_llm(word, emotion_dimension):
    """Gets a 0/1 score from Anthropic API."""
    prompt = f"Does the English word '{word}' strongly relate to the emotion '{emotion_dimension}'? Respond with only the single digit 1 for yes or 0 for no."
    print(f"  [LLM Query] Emotion score for '{word}' / '{emotion_dimension}'...")
    response = call_anthropic_llm(prompt, LLM_MODEL_EMOTION, max_tokens=5)
    
    if response is not None:
        try:
            score = int(response)
            if score in [0, 1]:
                return score
            else:
                print(f"    [LLM Warning] Invalid score digit received: '{response}'")
                return None
        except ValueError:
            print(f"    [LLM Warning] Non-integer score received: '{response}'")
            return None
    return None # API call failed or returned invalid data

def get_translation_from_llm(word, language_name):
    """Gets a translation from Anthropic API."""
    # Extract plain language name if format is "Language (code)"
    plain_language = language_name.split(' (')[0]
    prompt = f"What is the most common translation of the English word '{word}' into {plain_language}? Respond with only the single translated word or short phrase. If no direct translation exists, respond with 'N/A'."
    print(f"  [LLM Query] Translation for '{word}' to '{language_name}'...")
    response = call_anthropic_llm(prompt, LLM_MODEL_TRANSLATION, max_tokens=50) # More tokens for translations
    
    if response is not None and response.upper() != 'N/A':
        # Basic cleanup: remove potential quotes sometimes added by LLMs
        response = response.strip('"\'')
        return response
    elif response is not None and response.upper() == 'N/A':
        print(f"    [LLM Info] No direct translation found for '{word}' to '{language_name}'.")
        return "" # Return empty string for N/A
    return "" # API call failed or returned None

# --- Generic CSV Handling --- 

def load_csv(filepath):
    """Loads data from a CSV file."""
    if not os.path.exists(filepath):
        print(f"Error: File not found at '{filepath}'")
        return None, None # Return None for header and data
    
    data = []
    header = []
    try:
        with open(filepath, 'r', newline='', encoding='utf-8') as infile:
            reader = csv.reader(infile)
            header = next(reader)
            for row in reader:
                # Basic validation: ensure row has same number of columns as header
                if len(row) == len(header):
                    data.append(row)
                else:
                    print(f"Warning: Skipping malformed row in {filepath} (line {reader.line_num}): expected {len(header)} columns, got {len(row)}")
                    print(f"  Row content: {row}")
        print(f"Successfully loaded {len(data)} rows from {filepath}")
        return header, data
    except Exception as e:
        print(f"Error reading CSV file '{filepath}': {e}")
        sys.exit(1)

def save_csv(filepath, header, data):
    """Saves data to a CSV file atomically."""
    temp_filepath = filepath + ".tmp"
    try:
        with open(temp_filepath, 'w', newline='', encoding='utf-8') as outfile:
            writer = csv.writer(outfile)
            writer.writerow(header)
            writer.writerows(data)
        
        os.replace(temp_filepath, filepath)
        print(f"Successfully saved updated data to {filepath}")
        return True
    except Exception as e:
        print(f"Error writing CSV file '{filepath}': {e}")
        if os.path.exists(temp_filepath):
            try: os.remove(temp_filepath) 
            except OSError: pass
        return False

# --- Core Logic (Updated for Two Files) --- 

def add_emotion_dimension(emotions_filepath, new_emotion):
    """Adds a new emotion dimension column to the emotions CSV."""
    header, data = load_csv(emotions_filepath)
    if header is None:
        sys.exit(1)

    if new_emotion in header:
        print(f"Error: Emotion dimension '{new_emotion}' already exists in {emotions_filepath}.")
        sys.exit(1)

    print(f"Adding new emotion dimension '{new_emotion}' to {emotions_filepath}")
    header.append(new_emotion)
    new_emotion_col_index = len(header) - 1

    try:
        word_index = header.index('English Word')
    except ValueError:
        print(f"Error: 'English Word' column not found in {emotions_filepath}.")
        sys.exit(1)

    updated_data = []
    total_rows = len(data)
    for i, row in enumerate(data):
        word = row[word_index]
        print(f"Processing word {i+1}/{total_rows}: '{word}'")
        
        score = get_emotion_score_from_llm(word, new_emotion)
        
        if score is None:
             print(f"  -> Warning: Could not get score for '{word}'. Setting to 0.")
             score_str = "0" 
        else:
             print(f"  -> Score: {score}")
             score_str = str(score)

        # Ensure row is long enough before appending (though load_csv should handle this)
        if len(row) < new_emotion_col_index:
             row.extend(['0'] * (new_emotion_col_index - len(row))) # Pad with default '0'
             
        row.append(score_str)
        updated_data.append(row)

    save_csv(emotions_filepath, header, updated_data)

def add_word(emotions_filepath, translations_filepath, new_word):
    """Adds a new word to both emotions and translations CSVs."""
    emo_header, emo_data = load_csv(emotions_filepath)
    trans_header, trans_data = load_csv(translations_filepath)

    if emo_header is None or trans_header is None:
        sys.exit(1) # Error already printed by load_csv

    # Find word column index (should be 0 in both)
    try:
        emo_word_index = emo_header.index('English Word')
        trans_word_index = trans_header.index('English Word')
        if emo_word_index != 0 or trans_word_index != 0:
             print("Warning: 'English Word' column is not the first column in one or both files. Proceeding, but check file structure.")
    except ValueError:
        print("Error: 'English Word' column not found in one or both CSV files.")
        sys.exit(1)

    # Check if word already exists (case-insensitive check in emotions file)
    existing_words = {row[emo_word_index].lower() for row in emo_data}
    if new_word.lower() in existing_words:
        print(f"Error: Word '{new_word}' already exists in {emotions_filepath}.")
        sys.exit(1)

    print(f"Adding new word: '{new_word}' to both files.")

    # --- Process Emotions File --- 
    print("\nProcessing Emotions...")
    new_emo_row = [''] * len(emo_header)
    new_emo_row[emo_word_index] = new_word
    emotion_columns = [(col_name, i) for i, col_name in enumerate(emo_header) if i != emo_word_index]
    print(f"Getting scores for {len(emotion_columns)} emotion dimensions...")
    
    for emotion, index in emotion_columns:
        score = get_emotion_score_from_llm(new_word, emotion)
        if score is None:
             print(f"  -> Warning: Could not get score for '{emotion}'. Setting to 0.")
             score_str = "0"
        else:
             print(f"  -> Score for '{emotion}': {score}")
             score_str = str(score)
        new_emo_row[index] = score_str
        
    emo_data.append(new_emo_row)

    # --- Process Translations File --- 
    print("\nProcessing Translations...")
    new_trans_row = [''] * len(trans_header)
    new_trans_row[trans_word_index] = new_word
    language_columns = [(col_name, i) for i, col_name in enumerate(trans_header) if i != trans_word_index]
    print(f"Getting translations for {len(language_columns)} languages...")
    
    for language, index in language_columns:
        translation = get_translation_from_llm(new_word, language)
        if not translation:
             print(f"  -> Info: No translation obtained for '{language}'. Leaving empty.")
             translation_str = ""
        else:
             # Limit length just in case LLM is verbose
             translation_str = translation[:100] # Limit translation length
             print(f"  -> Translation for '{language}': {translation_str}")
             
        new_trans_row[index] = translation_str

    trans_data.append(new_trans_row)

    # --- Save Both Files --- 
    print("\nSaving updated files...")
    emo_saved = save_csv(emotions_filepath, emo_header, emo_data)
    trans_saved = save_csv(translations_filepath, trans_header, trans_data)

    if not emo_saved or not trans_saved:
        print("Error: Failed to save one or both files. Check previous error messages.")
        # Note: This could leave files in an inconsistent state if one saves and the other fails.
        # More robust implementation might involve backups or transactional saving.
        sys.exit(1)

# --- Main Execution --- 

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Manage the NRC Emotion and Translation Lexicon CSVs using Anthropic API.")
    parser.add_argument("--emotions-file", required=True, help="Path to the nrc_lexicon_emotions.csv file.")
    parser.add_argument("--translations-file", required=True, help="Path to the nrc_lexicon_translations.csv file.")
    
    mode_group = parser.add_mutually_exclusive_group(required=True)
    mode_group.add_argument("--add-emotion", metavar="EMOTION_NAME", help="Add a new emotion dimension to the emotions file.")
    mode_group.add_argument("--add-word", metavar="NEW_WORD", help="Add a new English word to both files.")

    args = parser.parse_args()

    # Basic file existence check (load_csv handles more specific errors)
    if not os.path.exists(args.emotions_file):
        print(f"Error: Emotions file not found at '{args.emotions_file}'")
        sys.exit(1)
    if not os.path.exists(args.translations_file):
        print(f"Error: Translations file not found at '{args.translations_file}'")
        sys.exit(1)
        
    if args.add_emotion:
        add_emotion_dimension(args.emotions_file, args.add_emotion)
    elif args.add_word:
        add_word(args.emotions_file, args.translations_file, args.add_word)

    print("\nScript finished.") 