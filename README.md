# ITIFY CRM — Enterprise Sales Workspace

A standalone, ultra-responsive Sales CRM & Pipeline Dashboard designed for high-velocity sales teams.

---

## ⚡ Highlights

- **Zero-Latency UI**: Works instantly, offline or online, powered by local persistence and background sync.
- **Google Sheets Real-time Sync**: Automatically saves new leads, status updates, amounts, and dated notes directly to your private Google Sheet.
- **1-Click CSV Backup**: Export full pipeline backups anytime with a single click.
- **IST & Indian Telephony Optimized**: Native `Asia/Kolkata` time zone, ₹ INR currency calculations, and one-tap click-to-call links (`tel:`).
- **Follow-up Reminders & Daily Pet Alert**: Categorized by Today, Tomorrow, Next Week, with an interactive morning reminder.
- **Customizable**: Edit field names and dashboard icons directly in the UI.

---

## 🚀 Running Locally

Open `index.html` directly in any web browser, or launch a quick local server:

```bash
cd itify-crm
python3 -m http.server 3000
```
Then visit: [http://localhost:3000](http://localhost:3000)

---

## ☁ Connecting Google Sheets (1-Minute Setup)

1. Open a new Google Sheet at [sheets.new](https://sheets.new) and name it **ITIFY CRM Leads**.
2. Click **Extensions** > **Apps Script**.
3. Replace any code with the contents of `google-sheets-sync.js`.
4. Click **Deploy** > **New deployment**.
5. Select type: **Web app**:
   - **Execute as**: `Me` (your Google email)
   - **Who has access**: `Anyone`
6. Click **Deploy**, copy your **Web app URL** (`https://script.google.com/macros/s/.../exec`).
7. Open **ITIFY CRM**, click **Cloud Sync** (top-right), paste the URL, and click **Save & Connect**.

---

## 🌐 Deploy Free on GitHub Pages

1. Push this repository to GitHub:
   ```bash
   git remote add origin https://github.com/amityadavsys-gif/ITIFY-CRM.git
   git branch -M main
   git push -u origin main
   ```
2. In GitHub, go to **Settings** > **Pages**.
3. Under **Branch**, select `main` and `/ (root)`, then click **Save**.
4. Your CRM is now live on the web for your team!
