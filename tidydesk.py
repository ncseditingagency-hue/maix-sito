#!/usr/bin/env python3
"""
TidyDesk - Organizzatore di file intelligente by Maix
Tutto incluso in un solo file. Nessuna chiave API è presente qui:
le richieste passano dal server di Maix (Netlify Function) che tiene
la chiave Groq al sicuro lato server.

Funziona come un chatbot unico: l'utente scrive in linguaggio naturale,
TidyDesk capisce da solo la cartella (Desktop, Download, Documenti...)
oppure chiede in modo intelligente se non è sicuro.
"""

import os
import sys
import json
import shutil
import random
import difflib
import threading
import webbrowser
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# ----------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------
MAIX_ENDPOINT = "https://atlasmaix.netlify.app/.netlify/functions/tidydesk-ai"
REQUEST_TIMEOUT = 35  # secondi (3 modelli di fallback x ~9s ciascuno + margine)

FALLBACK_CATEGORIES = {
    "Immagini": [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".svg", ".bmp"],
    "Documenti": [".pdf", ".doc", ".docx", ".txt", ".odt", ".rtf"],
    "Fogli di Calcolo": [".xls", ".xlsx", ".csv"],
    "Presentazioni": [".ppt", ".pptx"],
    "Video": [".mp4", ".mov", ".avi", ".mkv", ".webm"],
    "Audio": [".mp3", ".wav", ".aac", ".m4a"],
    "Archivi": [".zip", ".rar", ".7z", ".tar", ".gz"],
    "Installer": [".exe", ".dmg", ".pkg", ".msi"],
}

def _safe_isdir(path):
    try:
        return os.path.isdir(path)
    except Exception:
        return False


def _safe_listdir(path):
    try:
        return os.listdir(path)
    except Exception:
        return []


def _resolve_real_folder(*candidates):
    """Tra più percorsi possibili per la stessa cartella logica
    (es. con e senza OneDrive), ritorna il primo che esiste davvero
    e contiene almeno un file o una sottocartella (così evitiamo
    di scegliere per sbaglio la cartella vuota 'fantasma').
    Non lancia mai eccezioni: se una cartella dà errore di permessi
    (capita spesso con OneDrive) viene semplicemente ignorata."""
    existing = [c for c in candidates if _safe_isdir(c)]
    if not existing:
        return candidates[0]  # nessuna esiste, ritorna la prima come default

    non_empty = [c for c in existing if _safe_listdir(c)]
    if non_empty:
        return non_empty[0]
    return existing[0]


def _onedrive_roots():
    """Trova eventuali cartelle OneDrive presenti nella home dell'utente
    (es. 'OneDrive', 'OneDrive - Personale', 'OneDrive - NomeAzienda')."""
    roots = []
    for entry in _safe_listdir(HOME):
        full = os.path.join(HOME, entry)
        if entry.lower().startswith("onedrive") and _safe_isdir(full):
            roots.append(full)
    return roots


def _build_known_folders():
    """Costruisce la mappa parola -> percorso reale, controllando sia il
    percorso classico (C:\\Users\\Nome\\Desktop) sia quello dentro OneDrive
    (C:\\Users\\Nome\\OneDrive\\Desktop), qualsiasi sia la configurazione
    del PC (OneDrive attivo o no, una o più cartelle OneDrive)."""
    onedrive_roots = _onedrive_roots()

    def candidates_for(folder_name):
        paths = [os.path.join(HOME, folder_name)]
        for root in onedrive_roots:
            paths.append(os.path.join(root, folder_name))
        return paths

    mapping = {
        "desktop": _resolve_real_folder(*candidates_for("Desktop")),
        "scrivania": _resolve_real_folder(*candidates_for("Desktop")),
        "download": _resolve_real_folder(*candidates_for("Downloads")),
        "downloads": _resolve_real_folder(*candidates_for("Downloads")),
        "scaricati": _resolve_real_folder(*candidates_for("Downloads")),
        "documenti": _resolve_real_folder(*candidates_for("Documents"), *candidates_for("Documenti")),
        "documents": _resolve_real_folder(*candidates_for("Documents"), *candidates_for("Documenti")),
        "immagini": _resolve_real_folder(*candidates_for("Pictures"), *candidates_for("Immagini")),
        "pictures": _resolve_real_folder(*candidates_for("Pictures"), *candidates_for("Immagini")),
        "foto": _resolve_real_folder(*candidates_for("Pictures"), *candidates_for("Immagini")),
    }
    return mapping


HOME = os.path.expanduser("~")
try:
    KNOWN_FOLDERS = _build_known_folders()
except Exception:
    KNOWN_FOLDERS = {}


# ----------------------------------------------------------------------
# RICONOSCIMENTO CARTELLA DAL TESTO LIBERO
# ----------------------------------------------------------------------
def search_any_folder(text, max_depth=3):
    """
    Cerca QUALSIASI cartella nella home dell'utente (e nelle sue sottocartelle,
    fino a una certa profondità) che corrisponda a una parola del testo.
    Serve per i casi non previsti da KNOWN_FOLDERS, es. "organizza la cartella progetti".
    Ritorna (percorso, nome) oppure (None, None).
    """
    lowered = text.lower()
    words = [w.strip(',.;:!?"\'') for w in lowered.split() if len(w.strip(',.;:!?"\'')) >= 3]
    if not words:
        return None, None

    # Parole troppo generiche da ignorare nella ricerca (verbi, articoli comuni)
    stopwords = {"organizza", "ordina", "metti", "sistema", "separa", "cartella",
                 "file", "tutti", "voglio", "puoi", "vorrei", "dentro", "nella"}
    search_words = [w for w in words if w not in stopwords]
    if not search_words:
        return None, None

    best_match = None
    best_ratio = 0.0

    for root, dirs, _files in os.walk(HOME):
        # Limita la profondità per non scandagliare tutto il disco
        depth = root[len(HOME):].count(os.sep)
        if depth >= max_depth:
            dirs[:] = []  # non scendere oltre
            continue
        # Salta cartelle di sistema/nascoste, troppo pesanti da scandagliare
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in
                   ("appdata", "node_modules", "$recycle.bin", "windows", "program files",
                    "program files (x86)", ".git", "venv", "__pycache__")]

        folder_name = os.path.basename(root).lower()
        for word in search_words:
            ratio = difflib.SequenceMatcher(None, word, folder_name).ratio()
            if word == folder_name:
                ratio = 1.0
            if ratio > best_ratio and ratio >= 0.7:
                best_ratio = ratio
                best_match = root

    if best_match:
        return best_match, os.path.basename(best_match)
    return None, None


def detect_folder(text):
    """
    Cerca nel testo dell'utente una cartella nota (desktop, download...)
    oppure un percorso scritto per intero. Usa anche un confronto "fuzzy"
    per capire parole simili anche con piccoli errori di battitura
    (es. "destop", "downlod").
    Ritorna (percorso_reale, nome_leggibile) oppure (None, None).
    """
    lowered = text.lower()
    words = [w.strip(',.;:!?"\'') for w in lowered.split()]

    # 1. Percorso scritto per intero
    for token in text.split():
        cleaned = token.strip(',.;:"\'')
        candidate = os.path.expanduser(cleaned)
        if os.path.isdir(candidate):
            return candidate, cleaned

    # 2. Nome di cartella comune, anche come sottostringa
    for keyword, real_path in KNOWN_FOLDERS.items():
        if keyword in lowered and os.path.isdir(real_path):
            return real_path, keyword.capitalize()

    # 3. Corrispondenza fuzzy con le cartelle comuni note
    keywords = list(KNOWN_FOLDERS.keys())
    for word in words:
        if len(word) < 3:
            continue
        matches = difflib.get_close_matches(word, keywords, n=1, cutoff=0.75)
        if matches:
            keyword = matches[0]
            real_path = KNOWN_FOLDERS[keyword]
            if os.path.isdir(real_path):
                return real_path, keyword.capitalize()

    # 4. Ricerca universale: qualsiasi altra cartella nel PC con nome simile
    return search_any_folder(text)


def existing_known_folders():
    """Ritorna la lista delle cartelle comuni che esistono davvero su questo PC."""
    seen = {}
    for keyword, path in KNOWN_FOLDERS.items():
        if os.path.isdir(path) and path not in seen.values():
            seen[keyword.capitalize()] = path
    return seen


# ----------------------------------------------------------------------
# LOGICA DI ORGANIZZAZIONE FILE
# ----------------------------------------------------------------------
def fallback_categorize(filename):
    ext = os.path.splitext(filename)[1].lower()
    for category, extensions in FALLBACK_CATEGORIES.items():
        if ext in extensions:
            return category
    return "Altro"


def call_maix_ai(instruction, file_list):
    """Chiama il server di Maix. La chiave Groq resta sul server, mai qui.
    Ritorna (categorization, debug_error)."""
    payload = json.dumps({"instruction": instruction, "files": file_list}).encode("utf-8")
    req = urllib.request.Request(
        MAIX_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("categorization", None), body.get("debug") or body.get("error")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
            return None, body.get("debug") or body.get("error") or str(e)
        except Exception:
            return None, f"HTTP {e.code}: {e.reason}"
    except Exception as e:
        return None, f"Errore di connessione: {e}"


RENAME_KEYWORDS = ("rinomin", "rename", "cambia nome", "nomi dei file")


def wants_rename(text):
    lowered = text.lower()
    return any(k in lowered for k in RENAME_KEYWORDS)


def call_maix_rename(criterio, file_list):
    """Chiede all'AI di Maix nuovi nomi per i file, in base al criterio scelto dall'utente."""
    payload = json.dumps({"action": "rename", "criterio": criterio, "files": file_list}).encode("utf-8")
    req = urllib.request.Request(
        MAIX_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("renaming"), body.get("debug") or body.get("error")
    except Exception as e:
        return None, str(e)


def rename_files_in_folder(folder_path, criterio, log_callback):
    if not os.path.isdir(folder_path):
        log_callback("ai", f"Non trovo la cartella \"{folder_path}\".")
        return

    file_entries = scan_files_recursive(folder_path)  # [(percorso_completo, nome_relativo), ...]
    if not file_entries:
        log_callback("ai", "Questa cartella non ha file da rinominare.")
        return

    rel_names = [rel for _full, rel in file_entries]
    log_callback("ai", f"Penso a nomi migliori per {len(file_entries)} file, in base a \"{criterio}\"...")
    renaming, debug_error = call_maix_rename(criterio, rel_names)

    if not renaming:
        log_callback("error", f"Non sono riuscito a generare nuovi nomi ({debug_error or 'AI non disponibile'}).")
        return

    renamed = 0
    skipped_unchanged = 0
    for full_path, rel_name in file_entries:
        old_filename = os.path.basename(full_path)
        old_base = os.path.splitext(old_filename)[0]
        new_name = renaming.get(rel_name) or renaming.get(old_filename)

        # L'AI ritorna il nome SENZA estensione: confrontiamo coerentemente
        # con la base del nome originale, non con il nome completo, altrimenti
        # "nessun cambiamento" non viene mai riconosciuto come tale.
        if not new_name or new_name == old_base or os.path.basename(new_name) == old_base:
            skipped_unchanged += 1
            continue
        # Manteniamo l'estensione originale per sicurezza, anche se l'AI la cambia per errore
        old_ext = os.path.splitext(old_filename)[1]
        # L'AI potrebbe restituire un nome con sottocartelle incluse: prendiamo solo il nome file
        new_name = os.path.basename(new_name)
        if not os.path.splitext(new_name)[1]:
            new_name = new_name + old_ext

        folder_of_file = os.path.dirname(full_path)
        dest = os.path.join(folder_of_file, new_name)

        if not os.path.exists(full_path):
            continue
        if os.path.exists(dest) and os.path.abspath(dest) != os.path.abspath(full_path):
            dest = _find_free_name(folder_of_file, new_name)

        try:
            os.rename(full_path, dest)
            renamed += 1
            log_callback("file", f"{rel_name} → {os.path.basename(dest)}")
        except Exception as e:
            log_callback("error", f"Non sono riuscito a rinominare \"{rel_name}\": {e}")

    if renamed == 0:
        log_callback("done", "Ho controllato tutti i file, ma non ho trovato nomi da migliorare con questo criterio.")
    elif skipped_unchanged > 0:
        log_callback("done", f"Fatto! {renamed} file rinominati ({skipped_unchanged} erano già a posto, li ho lasciati così).")
    else:
        log_callback("done", f"Fatto! {renamed} file rinominati.")


def scan_files_recursive(folder_path, max_depth=6):
    """
    Trova TUTTI i file dentro la cartella, incluse le sottocartelle
    (a qualsiasi livello, fino a max_depth per sicurezza).
    Ritorna una lista di tuple (percorso_completo, nome_visualizzato),
    dove nome_visualizzato include il percorso relativo per far capire
    all'AI da dove viene il file (es. "Lavoro/2024/fattura.pdf").
    """
    results = []
    base_depth = folder_path.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(folder_path):
        depth = root.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= max_depth:
            dirs[:] = []
            continue
        # Evitiamo di rientrare nelle cartelle già create da TidyDesk stesso
        # in un giro precedente (altrimenti rimescola all'infinito).
        dirs[:] = [d for d in dirs if d not in FALLBACK_CATEGORIES and d.lower() not in SYSTEM_DIRS_TO_SKIP]

        for filename in files:
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, folder_path)
            results.append((full_path, rel_path))
    return results


def _find_free_name(dest_dir, filename):
    """
    Trova un nome file libero in dest_dir, anche quando ci sono 3 o più
    file con lo stesso nome (da sottocartelle diverse). Non sovrascrive
    mai un file esistente: prova _copia, poi _copia2, _copia3, ecc.
    """
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(dest_dir, f"{base}_copia{ext}")
    counter = 2
    while os.path.exists(candidate):
        candidate = os.path.join(dest_dir, f"{base}_copia{counter}{ext}")
        counter += 1
    return candidate


def organize_folder(folder_path, instruction, log_callback):
    if not os.path.isdir(folder_path):
        log_callback("ai", f"Non trovo la cartella \"{folder_path}\". Puoi controllare il nome e riprovare?")
        return

    log_callback("ai", smart_reply(
        "Stai per controllare il contenuto di una cartella che l'utente ti ha chiesto di organizzare. "
        "Dillo con una frase brevissima e naturale, come se stessi davvero dando un'occhiata in questo momento.",
        LOOKING_PHRASES
    ))
    file_entries = scan_files_recursive(folder_path)  # [(percorso_completo, nome_relativo), ...]

    if not file_entries:
        log_callback("ai", "Questa cartella è già vuota, non c'è nulla da organizzare! 🙂")
        return

    # All'AI mandiamo solo i nomi relativi (es. "Lavoro/fattura.pdf"),
    # così capisce anche la struttura delle sottocartelle.
    rel_names = [rel for _full, rel in file_entries]

    # Mini-statistica per dare un riepilogo più ricco e concreto, non solo "ho trovato X file"
    ext_counts = {}
    subfolder_count = len(set(os.path.dirname(rel) for rel in rel_names if os.path.dirname(rel)))
    for rel in rel_names:
        ext = os.path.splitext(rel)[1].lower() or "(senza estensione)"
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
    top_types = sorted(ext_counts.items(), key=lambda x: -x[1])[:3]
    types_summary = ", ".join(f"{count}× {ext}" for ext, count in top_types)
    extra_detail = f" (tra cui {types_summary})" if types_summary else ""
    if subfolder_count:
        extra_detail += f", distribuiti in {subfolder_count} sottocartell{'a' if subfolder_count == 1 else 'e'}"

    log_callback("ai", smart_reply(
        f"Hai appena contato {len(file_entries)} file dentro la cartella (alcuni anche in sottocartelle). "
        f"Dillo con una frase breve e naturale, tipo che stai pensando a come organizzarli.",
        FOUND_FILES_PHRASES, n=len(file_entries)
    ))
    if extra_detail:
        log_callback("stat", f"{len(file_entries)} file trovati{extra_detail}.")

    ai_result, debug_error = call_maix_ai(instruction, rel_names)
    used_fallback = ai_result is None
    if used_fallback:
        if debug_error:
            log_callback("error", f"AI non disponibile ({debug_error}). Uso il metodo base per tipo di file.")
        else:
            log_callback("ai", "Il mio assistente AI non risponde in questo momento, vado con il metodo base per tipo di file.")

    moved = 0
    for full_path, rel_name in file_entries:
        filename = os.path.basename(full_path)
        category = None
        if ai_result:
            category = ai_result.get(rel_name) or ai_result.get(filename)
        if not category:
            category = fallback_categorize(filename)

        dest_dir = os.path.join(folder_path, category)
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, filename)

        if os.path.abspath(dest) == os.path.abspath(full_path):
            continue  # è già nel posto giusto, non serve spostarlo

        if os.path.exists(dest):
            dest = _find_free_name(dest_dir, filename)

        try:
            shutil.move(full_path, dest)
            moved += 1
            log_callback("file", f"{rel_name} → {category}")
        except Exception as e:
            log_callback("error", f"Non sono riuscito a spostare \"{rel_name}\": {e}")

    # Pulizia: rimuoviamo le sottocartelle rimaste vuote dopo aver spostato tutto
    for root, dirs, files in os.walk(folder_path, topdown=False):
        if root == folder_path:
            continue
        try:
            if not os.listdir(root):
                os.rmdir(root)
        except Exception:
            pass

    if used_fallback:
        log_callback("done", smart_reply(
            f"Hai appena finito di organizzare {moved} file, ma senza l'aiuto dell'AI (era offline), "
            f"solo per tipo di estensione. Dillo con una frase breve, onesta ma comunque positiva.",
            DONE_FALLBACK_PHRASES, n=moved
        ))
    else:
        log_callback("done", smart_reply(
            f"Hai appena finito di organizzare con successo {moved} file con l'aiuto dell'AI. "
            f"Dillo con una frase breve, soddisfatta e naturale.",
            DONE_AI_PHRASES, n=moved
        ))

    log_callback("ai", smart_reply(
        f"Hai appena finito di organizzare {moved} file nella cartella \"{os.path.basename(folder_path)}\". "
        f"Chiedi all'utente, in una frase breve e amichevole, se vuole anche rinominare qualcosa, "
        f"sistemare un'altra cartella, oppure se può bastare così.",
        ["Vuoi che organizzi anche un'altra cartella, o rinomino qualcosa?",
         "Se vuoi posso anche rinominare i file o sistemare un'altra cartella, basta chiedere!",
         "Tutto pronto. Vuoi che faccia altro, tipo rinominare o organizzare un'altra cartella?"]
    ))


# ----------------------------------------------------------------------
# STATO CONVERSAZIONE (single-user, locale)
# ----------------------------------------------------------------------
STATE_LOCK = threading.Lock()
STATE = {
    "events": [],
    "busy": False,
    "pending_instruction": None,
    "folder_options": None,
    "mode": None,           # None oppure "rename"
    "rename_folder": None,  # cartella in attesa del criterio di rinomina
    "confirm_action": None,  # azione in attesa di conferma esplicita (sì/cambia)
    "conversation_history": [],  # memoria di TUTTA la conversazione corrente
}

MAX_HISTORY_MESSAGES = 40  # ~20 scambi, abbastanza per non perdere mai il contesto in una sessione normale


def remember(role, content):
    """Aggiunge un messaggio alla memoria della conversazione corrente."""
    with STATE_LOCK:
        STATE["conversation_history"].append({"role": role, "content": content})
        if len(STATE["conversation_history"]) > MAX_HISTORY_MESSAGES:
            STATE["conversation_history"] = STATE["conversation_history"][-MAX_HISTORY_MESSAGES:]


def get_history():
    with STATE_LOCK:
        return list(STATE["conversation_history"])


def push_event(event_type, text):
    with STATE_LOCK:
        STATE["events"].append({"type": event_type, "text": text})
    # Memorizziamo anche le risposte vere e proprie (non i bottoni, che non sono "parlato")
    if event_type in ("ai", "done", "error"):
        remember("assistant", text)


def push_buttons(options):
    """Invia una lista di bottoni cliccabili alla chat (es. nomi di cartelle)."""
    with STATE_LOCK:
        STATE["events"].append({"type": "buttons", "options": options})


GREETING_PHRASES = [
    "Perfetto, lavoro su \"{folder}\" 👍",
    "Ricevuto! Mi metto su \"{folder}\" subito 🙂",
    "Ok, vado su \"{folder}\" — un attimo...",
]

ASK_FOLDER_PHRASES_WITH_OPTIONS = [
    "Certo! Quale cartella devo organizzare? Sul tuo PC trovo facilmente queste: {lista} — ma dimmi anche il nome di una qualsiasi altra cartella, la cerco lo stesso.",
    "Volentieri! Le cartelle principali che vedo sono: {lista}. Se intendi un'altra cartella basta dirmi il nome, provo a trovarla.",
    "Va bene, dimmi solo dove: ho subito sotto mano {lista}, ma puoi nominarmi anche qualsiasi altra cartella del PC.",
]

ASK_FOLDER_PHRASES_NO_OPTIONS = [
    "Certo! Dimmi il percorso completo della cartella da organizzare (es. C:\\Users\\TuoNome\\Desktop).",
    "Va bene, ma non riesco a indovinare la cartella: scrivimi il percorso completo per favore.",
]

NOT_FOUND_PHRASES = [
    "Non sono riuscito a capire quale cartella. Ho trovato queste sul tuo PC: {lista}. Quale vuoi che organizzi? Oppure scrivi il percorso completo.",
    "Mmm, non l'ho ancora capita 🤔 Su questo PC ci sono: {lista}. Puoi scegliere una di queste o darmi un percorso esatto.",
]


START_PHRASES = [
    "Ok, organizzo \"{folder}\" — vediamo cosa c'è dentro...",
    "Mi metto subito su \"{folder}\" 🙂",
    "Perfetto, apro \"{folder}\" e do un'occhiata...",
]

LOOKING_PHRASES = [
    "Sto dando un'occhiata ai file qui dentro...",
    "Un secondo, sto controllando cosa c'è...",
    "Fammi vedere cosa devo organizzare...",
]

FOUND_FILES_PHRASES = [
    "Ho trovato {n} file. Fammi pensare a come organizzarli meglio...",
    "Ci sono {n} file qui. Sto decidendo come raggrupparli...",
    "{n} file trovati — penso al modo migliore di organizzarli...",
]

DONE_AI_PHRASES = [
    "Fatto! Ho organizzato {n} file con l'aiuto dell'AI.",
    "Tutto fatto ✅ {n} file sistemati, con un po' di intelligenza in più.",
    "Ecco qua, {n} file organizzati per bene!",
]

DONE_FALLBACK_PHRASES = [
    "Fatto! Ho organizzato {n} file (modalità base, senza AI).",
    "Ho sistemato {n} file usando solo le estensioni, l'AI non era disponibile.",
]


def call_maix_chitchat(context_text, history=None):
    """Chiede all'AI di Maix una risposta colloquiale breve, con memoria
    di tutta la conversazione fatta finora. Ritorna (reply, debug_error)."""
    payload = json.dumps({
        "action": "chitchat",
        "context": context_text,
        "history": history or []
    }).encode("utf-8")
    req = urllib.request.Request(
        MAIX_ENDPOINT,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            reply = body.get("reply")
            return (reply if reply else None), body.get("debug")
    except Exception as e:
        return None, str(e)


def smart_reply(context_text, fallback_phrases, **fmt):
    """Prova a far rispondere l'AI in modo naturale, con memoria della
    conversazione; se non risponde, usa una frase fissa a caso."""
    ai_reply, _debug_error = call_maix_chitchat(context_text, history=get_history())
    if ai_reply:
        return ai_reply
    return random.choice(fallback_phrases).format(**fmt) if fmt else random.choice(fallback_phrases)


FILE_ACTION_WORDS = (
    "organizz", "ordin", "metti", "sistema", "separ", "sposta", "pulis",
    "rinomin", "rename", "cambia nome",
    "cartell", "file", "desktop", "download", "scaricat", "documenti",
    "immagini", "foto", "video", "musica", "scrivania"
)


def looks_like_file_task(text):
    """Riconosce se il messaggio riguarda davvero l'organizzazione/rinomina
    di file e cartelle, a prescindere dalla lunghezza della frase."""
    lowered = text.lower()
    return any(w in lowered for w in FILE_ACTION_WORDS)


GREETING_WORDS = {
    "ciao", "hey", "hei", "salve", "buongiorno", "buonasera", "buonanotte",
    "ehi", "yo", "ola", "hello", "hi", "grazie", "ok", "okay", "va bene",
    "perfetto", "wow", "bello", "figo", "top", "ottimo"
}


def is_just_chitchat(text):
    """
    Distingue un semplice saluto/commento ("ciao", "grazie", "ok")
    da una vera richiesta di organizzare qualcosa.
    """
    cleaned = text.strip(",.;:!?\"'").lower()
    if cleaned in GREETING_WORDS:
        return True
    # Frase brevissima senza nessuna parola legata all'organizzazione dei file
    if len(cleaned.split()) <= 3 and not looks_like_file_task(cleaned):
        return True
    return False


MESSAGE_QUEUE = []
QUEUE_LOCK = threading.Lock()


def _queue_worker():
    """Gira per sempre in background: elabora i messaggi uno alla volta,
    nell'ordine in cui arrivano. Così nessun messaggio viene mai perso
    o ignorato, anche se l'utente scrive più frasi velocemente."""
    while True:
        text = None
        with QUEUE_LOCK:
            if MESSAGE_QUEUE:
                text = MESSAGE_QUEUE.pop(0)
        if text is not None:
            try:
                handle_user_message(text)
            except Exception as e:
                push_event("error", f"Si è verificato un problema interno: {e}")
            finally:
                # Fondamentale: a prescindere da cosa sia successo dentro
                # handle_user_message (anche solo una domanda, senza
                # organizzare nulla), il messaggio è comunque "concluso"
                # qui: l'interfaccia deve poter accettare il prossimo.
                with STATE_LOCK:
                    STATE["busy"] = False
        else:
            import time
            time.sleep(0.2)


SYSTEM_DIRS_TO_SKIP = {
    "appdata", "node_modules", "$recycle.bin", "windows", "program files",
    "program files (x86)", ".git", "venv", "__pycache__", ".cache",
    "applicationdata", "library", ".vscode", ".vs"
}


def list_all_real_folders():
    """
    Elenca TUTTE le cartelle reali visibili nella home dell'utente
    (non solo Desktop/Download/Documenti/Immagini), per mostrarle
    come bottoni cliccabili. Se dentro OneDrive ci sono le stesse
    cartelle "speciali", mostra quelle (più probabile che contengano
    i file veri) ed evita di mostrarle due volte.
    """
    results = {}  # nome_visibile -> percorso

    # Cartelle speciali già risolte (gestiscono il caso OneDrive)
    for keyword in ["desktop", "download", "documenti", "immagini"]:
        path = KNOWN_FOLDERS.get(keyword)
        if path and _safe_isdir(path):
            label = os.path.basename(path) or keyword.capitalize()
            results[label] = path

    onedrive_roots = _onedrive_roots()
    already_shown_paths = set(results.values())

    for entry in _safe_listdir(HOME):
        if entry.startswith("."):
            continue
        if entry.lower() in SYSTEM_DIRS_TO_SKIP:
            continue
        if entry.lower().startswith("onedrive"):
            continue  # la apriamo a parte sotto, non come cartella generica
        full = os.path.join(HOME, entry)
        if _safe_isdir(full) and full not in already_shown_paths:
            results[entry] = full
            already_shown_paths.add(full)

    # Guarda anche dentro le cartelle OneDrive, un livello sotto
    for root in onedrive_roots:
        for entry in _safe_listdir(root):
            if entry.startswith("."):
                continue
            if entry.lower() in SYSTEM_DIRS_TO_SKIP:
                continue
            full = os.path.join(root, entry)
            if _safe_isdir(full) and full not in already_shown_paths:
                results[entry] = full
                already_shown_paths.add(full)

    return results  # {"Desktop": "/path/...", "Progetti": "/path/...", ...}


def handle_user_message(text):
    """
    Punto di ingresso unico: l'utente scrive una frase, qui si decide cosa fare.
    Mai un errore secco: si risponde sempre in modo colloquiale.
    """
    text = text.strip()
    if not text:
        return

    remember("user", text)

    with STATE_LOCK:
        was_pending = STATE["pending_instruction"] is not None
        pending_instruction = STATE["pending_instruction"]
        folder_options = STATE.get("folder_options") or {}
        rename_folder_waiting = STATE.get("rename_folder")
        confirm_action = STATE.get("confirm_action")

    # Se stiamo aspettando una conferma esplicita prima di agire
    if confirm_action:
        lowered = text.strip().lower()
        wants_confirm = lowered.startswith("✅") or lowered in ("si", "sì", "sì, vai", "ok", "vai", "confermo", "yes")
        wants_change = lowered.startswith("✏️") or "cambia" in lowered

        with STATE_LOCK:
            STATE["confirm_action"] = None

        if wants_confirm:
            with STATE_LOCK:
                STATE["busy"] = True
            organize_folder(confirm_action["folder_path"], confirm_action["instruction"], push_event)
            with STATE_LOCK:
                STATE["busy"] = False
            return
        elif wants_change:
            push_event("ai", "Va bene, dimmi pure come vuoi che lo faccia invece.")
            return
        # Altrimenti: l'utente ha scritto qualcos'altro invece di rispondere
        # alla conferma — trattiamolo come un nuovo messaggio normale,
        # ignorando semplicemente la richiesta di conferma rimasta in sospeso.

    # Se stiamo aspettando il CRITERIO per rinominare (es. "per data", "per cliente")
    if rename_folder_waiting:
        with STATE_LOCK:
            STATE["rename_folder"] = None
            STATE["mode"] = None
            STATE["busy"] = True
        push_event("ai", smart_reply(
            f"L'utente ha indicato il criterio \"{text}\" per rinominare i file. Confermagli brevemente che inizi.",
            ["Ok, rinomino i file in base a questo criterio, un secondo...",
             "Perfetto, ci penso subito.",
             "Va bene, parto con la rinomina."]
        ))
        rename_files_in_folder(rename_folder_waiting, text, push_event)
        with STATE_LOCK:
            STATE["busy"] = False
        return

    # Se l'utente vuole rinominare ma non sappiamo ancora la cartella
    if not was_pending and wants_rename(text):
        folder_path, folder_label = detect_folder(text)
        if folder_path:
            with STATE_LOCK:
                STATE["rename_folder"] = folder_path
            push_event("ai", smart_reply(
                f"L'utente vuole rinominare i file nella cartella \"{folder_label}\". "
                f"Chiedigli, in modo amichevole, in base a cosa vuole rinominarli (es. contenuto del file, data, nome cliente).",
                ["In base a cosa vuoi che rinomini i file? (es. contenuto, data, nome cliente...)"]
            ))
        else:
            with STATE_LOCK:
                STATE["mode"] = "rename"
            options = list_all_real_folders()
            with STATE_LOCK:
                STATE["folder_options"] = options
            push_event("ai", "Certo! I file di quale cartella vuoi che rinomini (la cartella resta com'è, rinomino solo i file dentro)? Scegli un bottone o scrivimi il nome.")
            if options:
                push_buttons(list(options.keys())[:8])
        return

    # Se il testo corrisponde esattamente a un bottone/cartella mostrato
    # poco prima (es. l'utente ha cliccato "Progetti"), usalo direttamente.
    matched_option = None
    for label, path in folder_options.items():
        if text.strip().lower() == label.lower():
            matched_option = (path, label)
            break

    if matched_option:
        folder_path, folder_label = matched_option

        with STATE_LOCK:
            in_rename_mode = STATE.get("mode") == "rename"

        if in_rename_mode:
            with STATE_LOCK:
                STATE["mode"] = None
                STATE["folder_options"] = None
                STATE["rename_folder"] = folder_path
            push_event("ai", smart_reply(
                f"L'utente ha scelto la cartella \"{folder_label}\" per rinominare i file. "
                f"Chiedigli, amichevolmente, in base a cosa vuole rinominarli.",
                ["In base a cosa vuoi che rinomini i file? (es. contenuto, data, nome cliente...)"]
            ))
            return

        real_instruction = pending_instruction if (pending_instruction and not is_just_chitchat(pending_instruction)) else "organizza per tipo di file"
        with STATE_LOCK:
            STATE["pending_instruction"] = None
            STATE["folder_options"] = None
            STATE["busy"] = True
        push_event("ai", smart_reply(
            f"L'utente ha scelto la cartella \"{folder_label}\" cliccando su un bottone. Conferma brevemente che inizi a lavorarci.",
            GREETING_PHRASES, folder=folder_label
        ))
        organize_folder(folder_path, real_instruction, push_event)
        with STATE_LOCK:
            STATE["busy"] = False
        return

    # Se è solo un saluto/commento e non stiamo aspettando una risposta
    # specifica, rispondi in modo colloquiale senza chiedere cartelle.
    if not was_pending and is_just_chitchat(text):
        push_event("ai", smart_reply(
            f"L'utente ha scritto solo \"{text}\" (un saluto o un commento, non una richiesta di organizzare file). "
            f"Rispondi in modo amichevole e breve, e chiedigli cosa vuole che organizzi.",
            ["Ciao! 😊 Dimmi pure cosa vuoi che organizzi, quando vuoi.",
             "Ehi! Sono qui, pronto quando vuoi organizzare qualcosa.",
             "Di nulla! Fammi sapere se vuoi che metta in ordine qualche cartella."]
        ))
        return

    if was_pending:
        folder_path, folder_label = detect_folder(text)
        if folder_path:
            # Se l'istruzione originale era senza senso (es. "mmm", "ciao"),
            # non la passiamo all'AI: useremmo come comando una parola a caso.
            real_instruction = pending_instruction
            if is_just_chitchat(pending_instruction):
                real_instruction = "organizza per tipo di file"

            with STATE_LOCK:
                STATE["pending_instruction"] = None
                STATE["busy"] = True
            push_event("ai", smart_reply(
                f"L'utente ha confermato la cartella \"{folder_label}\". Conferma brevemente che inizi a lavorarci.",
                GREETING_PHRASES, folder=folder_label
            ))
            organize_folder(folder_path, real_instruction, push_event)
            with STATE_LOCK:
                STATE["busy"] = False
            return
        else:
            options = list_all_real_folders()
            with STATE_LOCK:
                STATE["folder_options"] = options
            if options:
                lista = ", ".join(list(options.keys())[:8])
                push_event("ai", smart_reply(
                    f"L'utente ha scritto \"{text}\" ma non capisco a quale cartella si riferisce. "
                    f"Ho trovato queste cartelle sul PC: {lista}. Chiedigli di nuovo, in modo gentile, quale vuole, "
                    f"dicendo che può anche cliccare un bottone qui sotto.",
                    NOT_FOUND_PHRASES, lista=lista
                ))
                push_buttons(list(options.keys())[:8])
            else:
                push_event("ai", "Non riesco a trovare quella cartella. Puoi scrivere il percorso completo (es. C:\\Users\\TuoNome\\Desktop)?")
            return

    folder_path, folder_label = detect_folder(text)

    if folder_path:
        # Prima di agire, chiediamo sempre una conferma esplicita:
        # l'utente potrebbe aver scritto la cartella giusta ma con
        # un'istruzione che vuole rivedere prima che si parta.
        with STATE_LOCK:
            STATE["confirm_action"] = {"folder_path": folder_path, "folder_label": folder_label, "instruction": text}
        push_event("ai", smart_reply(
            f"L'utente vuole organizzare la cartella \"{folder_label}\" con questa richiesta: \"{text}\". "
            f"Riassumi in una frase breve cosa stai per fare e chiedi conferma prima di iniziare.",
            [f"Confermi che organizzo \"{folder_label}\" così: \"{text}\"?"]
        ))
        push_buttons(["✅ Sì, vai", "✏️ Cambia richiesta"])
    else:
        if not looks_like_file_task(text):
            # Non è una richiesta sui file: rispondiamo come un assistente
            # AI normale, senza tirare in mezzo cartelle che l'utente
            # non ha mai chiesto. TidyDesk deve aiutare PRIMA con la domanda
            # reale, e solo se serve proporre l'organizzazione DOPO.
            ai_reply, debug_error = call_maix_chitchat(text, history=get_history())
            if ai_reply:
                push_event("ai", ai_reply)
            else:
                push_event("error", f"Non riesco a risponderti ora ({debug_error or 'AI non disponibile'}). Riprova tra poco.")
            return

        with STATE_LOCK:
            STATE["pending_instruction"] = text
        options = list_all_real_folders()
        with STATE_LOCK:
            STATE["folder_options"] = options
        if options:
            lista = ", ".join(list(options.keys())[:8])
            push_event("ai", smart_reply(
                f"L'utente ha scritto \"{text}\" ma non ha specificato una cartella riconoscibile. "
                f"Ho trovato queste cartelle sul PC: {lista}. Chiedigli in modo amichevole quale cartella organizzare, "
                f"dicendo che può anche cliccare un bottone qui sotto oppure nominarne un'altra.",
                ASK_FOLDER_PHRASES_WITH_OPTIONS, lista=lista
            ))
            push_buttons(list(options.keys())[:8])
        else:
            push_event("ai", random.choice(ASK_FOLDER_PHRASES_NO_OPTIONS))


# ----------------------------------------------------------------------
# PAGINA HTML — chat unica
# ----------------------------------------------------------------------
HTML_PAGE = """<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗂️</text></svg>">
<title>TidyDesk - by Maix</title>
<style>
  :root {
    --bg: #faf8f5;
    --card: #ffffff;
    --accent: #5b4636;
    --accent-light: #8a7560;
    --text: #2b2420;
    --muted: #8a8178;
    --border: #e8e2d8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(-45deg, #f3a96b, #e87d6b, #8a5fb0, #5b8fd6, #f3a96b);
    background-size: 400% 400%;
    animation: gradientShift 18s ease infinite;
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow: hidden;
  }
  @keyframes gradientShift {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .float-icon {
    position: absolute;
    font-size: 38px;
    opacity: 0.18;
    animation: floaty 9s ease-in-out infinite;
    pointer-events: none;
    filter: drop-shadow(0 4px 8px rgba(0,0,0,0.15));
  }
  @keyframes floaty {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(-30px) rotate(8deg); }
  }
  .fi1 { top: 8%; left: 6%; font-size: 50px; animation-delay: 0s; }
  .fi2 { top: 15%; right: 10%; font-size: 42px; animation-delay: 1.5s; }
  .fi3 { bottom: 12%; left: 10%; font-size: 46px; animation-delay: 3s; }
  .fi4 { bottom: 18%; right: 7%; font-size: 38px; animation-delay: 4.5s; }
  .fi5 { top: 45%; left: 3%; font-size: 34px; animation-delay: 2s; }
  .fi6 { top: 38%; right: 4%; font-size: 36px; animation-delay: 5s; }
  .fi7 { top: 70%; left: 45%; font-size: 30px; animation-delay: 6s; }
  .app {
    width: 100%;
    max-width: 560px;
    height: 660px;
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(6px);
    border-radius: 22px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 2;
  }
  .header {
    padding: 18px 24px;
    background: linear-gradient(120deg, #6b4f3a, #8a7560 45%, #b89b7e 100%);
    color: white;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    position: relative;
    overflow: hidden;
  }
  .header::after {
    content: "";
    position: absolute;
    top: -40%; right: -10%;
    width: 160px; height: 160px;
    background: radial-gradient(circle, rgba(255,255,255,0.25), transparent 70%);
    border-radius: 50%;
  }
  .avatar {
    width: 42px; height: 42px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(255,255,255,0.35), rgba(255,255,255,0.1));
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
    position: relative;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.3);
  }
  .avatar .live {
    position: absolute;
    bottom: -2px; right: -2px;
    width: 11px; height: 11px;
    border-radius: 50%;
    background: radial-gradient(circle, #6ee7a0, #34c759);
    border: 2px solid #6b4f3a;
    box-shadow: 0 0 6px #4ade80;
  }
  .header h1 { margin: 0; font-size: 17px; display: flex; align-items: center; gap: 6px; }
  .header p { margin: 1px 0 0; font-size: 12px; opacity: 0.85; }

  .chat {
    flex: 1;
    padding: 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: linear-gradient(180deg, #fdfbf8, #faf6f0);
  }
  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 13.5px;
    line-height: 1.4;
    animation: pop 0.2s ease;
  }
  @keyframes pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .msg.ai {
    background: linear-gradient(135deg, #f3eee4, #ece3d4);
    align-self: flex-start;
    border-bottom-left-radius: 4px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .msg.user {
    background: linear-gradient(135deg, #6b4f3a, #5b4636);
    color: white;
    align-self: flex-end;
    border-bottom-right-radius: 4px;
    box-shadow: 0 2px 6px rgba(91,70,54,0.3);
  }
  .msg.error { background: linear-gradient(135deg, #fbe5e2, #f6d3ce); color: #8a3128; }
  .msg.done { background: linear-gradient(135deg, #e3f0e6, #d4ecd9); color: #2d5a3d; font-weight: 600; }
  .msg.done::before { content: "✅ "; }
  .msg.error::before { content: "⚠️ "; }
  .msg.file { font-size: 12.5px; color: var(--muted); background: transparent; padding: 2px 14px; align-self: flex-start; }
  .msg.file::before { content: "📄 "; }
  .msg.stat {
    align-self: flex-start;
    background: linear-gradient(135deg, #eef6ff, #e3eefc);
    color: #2c5a8a;
    font-size: 12.5px;
    font-weight: 500;
    border: 1px solid #d3e6fa;
    padding: 8px 14px;
  }
  .msg.stat::before { content: "📊 "; }

  .btn-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 4px 0 4px 0;
  }
  .option-btn {
    padding: 9px 14px;
    border-radius: 18px;
    border: none;
    color: white;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    box-shadow: 0 3px 10px rgba(0,0,0,0.15);
  }
  .option-btn:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 5px 14px rgba(0,0,0,0.22); }
  .option-btn-alt {
    background: linear-gradient(135deg, #d8d2c6, #c7bfae) !important;
    color: var(--accent) !important;
    font-weight: 500;
  }

  .typing-bubble {
    align-self: flex-start;
    background: linear-gradient(135deg, #f3eee4, #ece3d4);
    padding: 12px 16px;
    border-radius: 14px;
    border-bottom-left-radius: 4px;
    display: flex;
    gap: 4px;
  }
  .typing-bubble span {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent-light);
    animation: bounce 1.2s infinite;
  }
  .typing-bubble span:nth-child(2) { animation-delay: 0.15s; }
  .typing-bubble span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%,60%,100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }

  .composer {
    padding: 14px 16px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    gap: 8px;
    background: linear-gradient(180deg, #ffffff, #fbf9f6);
  }
  input[type=text] {
    flex: 1;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 14px;
  }
  button {
    padding: 12px 20px;
    border: none;
    border-radius: 10px;
    background: linear-gradient(135deg, #6b4f3a, #8a7560);
    color: white;
    font-size: 14px;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: 0 3px 10px rgba(91,70,54,0.3);
  }
  button:hover { background: linear-gradient(135deg, #5b4636, #7a6450); }
  button:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
</style>
</head>
<body>
  <div class="float-icon fi1">🗂️</div>
  <div class="float-icon fi2">✨</div>
  <div class="float-icon fi3">📁</div>
  <div class="float-icon fi4">🤖</div>
  <div class="float-icon fi5">📄</div>
  <div class="float-icon fi6">🖼️</div>
  <div class="float-icon fi7">🎵</div>
  <div class="app">
    <div class="header">
      <div class="avatar">🗂️<span class="live"></span></div>
      <div>
        <h1>TidyDesk ✨</h1>
        <p>🤖 Il tuo assistente per organizzare i file — by Maix <span style="opacity:0.5; font-size:10px;">v2</span></p>
      </div>
    </div>

    <div class="chat" id="chat">
      <div class="msg ai">👋 Ciao! Dimmi cosa vuoi che organizzi — es. "metti in ordine il desktop" o "separa le foto dai pdf nei download". Capisco da solo di che cartella parli!</div>
    </div>

    <div class="composer">
      <input type="text" id="userInput" placeholder="💬 Scrivi qui, es. organizza il desktop..." onkeydown="if(event.key==='Enter') sendMessage()">
      <button id="sendBtn" onclick="sendMessage()">🚀 Invia</button>
    </div>
  </div>

<script>
let polling = null;
let shownCount = 0;
let typingEl = null;

// Appena la pagina si apre, mostra subito le cartelle reali del PC come
// bottoni, prima ancora che l'utente scriva qualcosa.
window.addEventListener('DOMContentLoaded', () => {
  fetch('/folders').then(r => r.json()).then(data => {
    if (data.options && data.options.length) {
      addButtons(data.options);
    }
  }).catch(() => {});
});

function scrollDown() {
  const chat = document.getElementById('chat');
  chat.scrollTop = chat.scrollHeight;
}

function addMsg(cls, text) {
  removeTyping();
  const chat = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.textContent = text;
  chat.appendChild(div);
  scrollDown();
}

function folderEmoji(name) {
  const n = name.toLowerCase();
  if (n.includes('desktop') || n.includes('scrivania')) return '🖥️';
  if (n.includes('download') || n.includes('scaricat')) return '⬇️';
  if (n.includes('document')) return '📄';
  if (n.includes('immagini') || n.includes('picture') || n.includes('foto')) return '🖼️';
  if (n.includes('video') || n.includes('film')) return '🎬';
  if (n.includes('music') || n.includes('musica') || n.includes('audio')) return '🎵';
  if (n.includes('lavoro') || n.includes('work') || n.includes('progett')) return '💼';
  if (n.includes('archivi') || n.includes('zip')) return '🗄️';
  return '📁';
}

const BTN_GRADIENTS = [
  'linear-gradient(135deg, #f3a96b, #e87d6b)',
  'linear-gradient(135deg, #8a5fb0, #6f4aa0)',
  'linear-gradient(135deg, #5b8fd6, #4a72c0)',
  'linear-gradient(135deg, #4caf82, #3d9268)',
  'linear-gradient(135deg, #e8638b, #d4486f)',
  'linear-gradient(135deg, #d6a23a, #c08a25)',
];

function addButtons(options) {
  removeTyping();
  const chat = document.getElementById('chat');
  const wrap = document.createElement('div');
  wrap.className = 'btn-row';
  options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'option-btn';
    b.style.background = BTN_GRADIENTS[i % BTN_GRADIENTS.length];
    b.textContent = folderEmoji(opt) + ' ' + opt;
    b.onclick = () => { if (!document.getElementById('sendBtn').disabled) sendMessage(opt); };
    wrap.appendChild(b);
  });

  // Bottone extra: permette sempre di cambiare idea facilmente
  const otherBtn = document.createElement('button');
  otherBtn.className = 'option-btn option-btn-alt';
  otherBtn.textContent = '✏️ Scrivi un\\'altra cartella';
  otherBtn.onclick = () => { document.getElementById('userInput').focus(); };
  wrap.appendChild(otherBtn);

  chat.appendChild(wrap);
  scrollDown();
}

function showTyping() {
  if (typingEl) return;
  const chat = document.getElementById('chat');
  typingEl = document.createElement('div');
  typingEl.className = 'typing-bubble';
  typingEl.innerHTML = '<span></span><span></span><span></span>';
  chat.appendChild(typingEl);
  scrollDown();
}

function removeTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function sendMessage(forcedText) {
  const input = document.getElementById('userInput');
  if (document.getElementById('sendBtn').disabled) return; // già occupato, ignora
  const text = (forcedText !== undefined ? forcedText : input.value.trim());
  if (!text) return;

  addMsg('user', text);
  input.value = '';
  document.getElementById('sendBtn').disabled = true;
  input.disabled = true;
  showTyping();

  fetch('/message', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({text})
  }).then(() => {
    polling = setInterval(pollStatus, 500);
  }).catch(() => {
    addMsg('error', 'Non riesco a contattare TidyDesk. Controlla che il programma sia ancora avviato, poi riprova.');
    document.getElementById('sendBtn').disabled = false;
    document.getElementById('userInput').disabled = false;
  });
}

function pollStatus() {
  fetch('/status').then(r => r.json()).then(data => {
    const events = data.events;
    for (let i = shownCount; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'buttons') {
        addButtons(ev.options);
        continue;
      }
      const cls = ev.type === 'error' ? 'error' : ev.type === 'done' ? 'done' : ev.type === 'file' ? 'file' : ev.type === 'stat' ? 'stat' : 'ai';
      addMsg(cls, ev.text);
    }
    shownCount = events.length;

    if (!data.busy) {
      clearInterval(polling);
      removeTyping();
      document.getElementById('sendBtn').disabled = false;
      document.getElementById('userInput').disabled = false;
      document.getElementById('userInput').focus();
    } else {
      showTyping();
    }
  }).catch(() => {
    // Il server potrebbe essere stato appena riavviato (es. dopo un
    // aggiornamento): non blocchiamo la UI, riproviamo al prossimo giro.
  });
}
</script>
</body>
</html>
"""


# ----------------------------------------------------------------------
# SERVER LOCALE
# ----------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _send_json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path == "/status":
            with STATE_LOCK:
                self._send_json({"events": STATE["events"], "busy": STATE["busy"]})
        elif parsed.path == "/folders":
            # Restituisce subito le cartelle reali del PC, per mostrarle
            # come bottoni fin dal primo istante, prima ancora che l'utente scriva.
            options = list_all_real_folders()
            with STATE_LOCK:
                STATE["folder_options"] = options
            self._send_json({"options": list(options.keys())[:8]})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/message":
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            text = data.get("text", "")

            with QUEUE_LOCK:
                MESSAGE_QUEUE.append(text)
            with STATE_LOCK:
                STATE["busy"] = True

            self._send_json({"ok": True})
        else:
            self.send_response(404)
            self.end_headers()


def main():
    import socket
    threading.Thread(target=_queue_worker, daemon=True).start()
    PREFERRED_PORT = 8743

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", PREFERRED_PORT))
        sock.close()
        free_port = PREFERRED_PORT
    except OSError:
        # La porta preferita è occupata (es. un'altra istanza già aperta):
        # ne sceglie una libera automaticamente.
        sock.close()
        sock2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock2.bind(("127.0.0.1", 0))
        free_port = sock2.getsockname()[1]
        sock2.close()

    server = HTTPServer(("127.0.0.1", free_port), Handler)
    url = f"http://127.0.0.1:{free_port}"
    print(f"TidyDesk avviato su {url}")
    print("Se non si apre da solo il browser, copia e incolla questo indirizzo.")
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTidyDesk chiuso.")
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        print("\n--- TidyDesk ha incontrato un errore ---")
        traceback.print_exc()
        print("\nCopia questo messaggio e mandalo per assistenza.")
        try:
            input("\nPremi INVIO per chiudere...")
        except Exception:
            pass
        sys.exit(1)
