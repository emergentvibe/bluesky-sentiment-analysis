import csv
import os
from collections import defaultdict

# Define input and output file paths
# Assumes the script is run from the workspace root or the txt file is in the same directory
input_txt_file = 'NRC-Emotion-Lexicon-ForVariousLanguages.txt' # Input file
emotions_csv_file = 'nrc_lexicon_emotions.csv' # Output for emotions
translations_csv_file = 'nrc_lexicon_translations.csv' # Output for translations

# Check if the input file exists
if not os.path.exists(input_txt_file):
    print(f"Error: Input file not found at '{input_txt_file}'")
    print("Please make sure the file exists in the correct location.")
    exit()

# Dictionary to store consolidated data: {english_word: {'scores': {emotion: value}, 'translations': {language: translation}}}
word_data = defaultdict(lambda: {'scores': {}, 'translations': {}})

# Define expected emotion columns
expected_emotion_columns = ['anger', 'anticipation', 'disgust', 'fear', 'joy', 'negative', 'positive', 'sadness', 'surprise', 'trust']
num_emotion_columns = len(expected_emotion_columns)

print(f"Reading and processing data from {input_txt_file}...")

language_columns_header = [] # To store the names of language columns from the header
emotion_columns_header = [] # To store names of emotion columns from the header

# Read the text file and populate the dictionary
try:
    with open(input_txt_file, 'r', encoding='utf-8') as infile:
        # Read header line
        header_line = infile.readline().strip()
        if not header_line:
             print("Error: Input file seems empty or header is missing.")
             exit()
        header = header_line.split('\t')

        # Validate header structure
        if not header or header[0] != 'English Word' or len(header) < (1 + num_emotion_columns) or header[1:1+num_emotion_columns] != expected_emotion_columns:
             print(f"Error: Unexpected header format in input file. Expected 'English Word' followed by {expected_emotion_columns}")
             print(f"Actual header starts with: {header[:1+num_emotion_columns]}")
             exit()

        emotion_columns_header = header[1:1+num_emotion_columns]
        language_columns_header = header[1+num_emotion_columns:] # All columns after emotions are languages

        # Read data lines
        processed_words = set() # Keep track of words for which scores have been stored
        for i, line in enumerate(infile):
            parts = line.strip().split('\t')
            # Check if row has the correct number of columns matching the header
            if len(parts) == len(header):
                english_word = parts[0]
                scores_list = parts[1:1+num_emotion_columns]
                translations_list = parts[1+num_emotion_columns:]

                # Process only if word is not empty
                if english_word:
                    # Store scores only ONCE per English word (using the first encounter)
                    if english_word not in processed_words:
                         try:
                             word_data[english_word]['scores'] = {emotion: int(score) for emotion, score in zip(emotion_columns_header, scores_list)}
                             processed_words.add(english_word)
                         except ValueError:
                              print(f"Warning: Skipping scores on line {i+2} ('{english_word}') due to non-integer value(s): {scores_list}. Word might lack scores.")
                              # We don't add to processed_words, maybe scores appear on a later line?

                    # Store translations, consolidating from all lines for the same word
                    for lang_col, translation in zip(language_columns_header, translations_list):
                        if translation: # Only store non-empty translations
                            word_data[english_word]['translations'][lang_col] = translation
            else:
                # Handle potential format variations or empty lines gracefully
                if line.strip(): # Avoid warning for empty lines
                    print(f"Warning: Skipping malformed line {i+2} (expected {len(header)} columns, got {len(parts)}): {line.strip()}")

except FileNotFoundError:
    print(f"Error: Could not open input file '{input_txt_file}'.")
    exit()
except Exception as e:
    print(f"An error occurred while reading the input file: {e}")
    exit()


if not word_data:
    print("Error: No word data was processed. Check the input file format and content.")
    exit()

# --- Write Emotions CSV --- 
emotions_csv_header = ['English Word'] + sorted(emotion_columns_header)
print(f"Writing emotion data to {emotions_csv_file}...")
try:
    with open(emotions_csv_file, 'w', newline='', encoding='utf-8') as outfile:
        writer = csv.writer(outfile)
        writer.writerow(emotions_csv_header)
        for word in sorted(word_data.keys()):
            data = word_data[word]
            score_map = data['scores']
            # Ensure scores exist for the word before writing
            if score_map: 
                row = [word] + [score_map.get(emotion, 0) for emotion in sorted(emotion_columns_header)]
                writer.writerow(row)
            else:
                 print(f"Warning: No valid scores found for word '{word}'. Not writing to emotions CSV.")
    print(f"Successfully wrote {len(word_data)} words to {emotions_csv_file}")
except IOError as e:
    print(f"Error writing emotions CSV file '{emotions_csv_file}': {e}")
except Exception as e:
    print(f"An unexpected error occurred during emotions CSV writing: {e}")

# --- Write Translations CSV --- 
translations_csv_header = ['English Word'] + sorted(language_columns_header)
print(f"Writing translation data to {translations_csv_file}...")
try:
    with open(translations_csv_file, 'w', newline='', encoding='utf-8') as outfile:
        writer = csv.writer(outfile)
        writer.writerow(translations_csv_header)
        for word in sorted(word_data.keys()):
            data = word_data[word]
            translation_map = data['translations']
            # Write translation row even if some translations are missing
            row = [word] + [translation_map.get(lang, '') for lang in sorted(language_columns_header)]
            writer.writerow(row)
    print(f"Successfully wrote {len(word_data)} words to {translations_csv_file}")
except IOError as e:
    print(f"Error writing translations CSV file '{translations_csv_file}': {e}")
except Exception as e:
    print(f"An unexpected error occurred during translations CSV writing: {e}")

print("Conversion finished.") 