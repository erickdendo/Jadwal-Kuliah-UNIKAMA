// ========== PWA install prompt ==========
let deferredPrompt = null;
const btnInstall = document.getElementById("btnInstall");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  btnInstall.hidden = false;
});

btnInstall?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  btnInstall.hidden = true;
});

// ========== Service worker ==========
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js");
}

// ========== Notification permission ==========
const btnNotify = document.getElementById("btnNotify");
btnNotify.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    alert("Browser tidak mendukung Notification API.");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    showInfo("Notifikasi diaktifkan. Pengingat akan muncul saat aplikasi berjalan/terbuka.");
  } else {
    showInfo("Notifikasi tidak diizinkan. Kamu tetap bisa pakai jadwal tanpa notifikasi.");
  }
});

// ========== IndexedDB helper ==========
const DB_NAME = "unikama_schedule_db";
const DB_VERSION = 1;
const STORE = "schedules";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("day", "day");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// ========== UI logic ==========
const form = document.getElementById("scheduleForm");
const listEl = document.getElementById("scheduleList");
const infoEl = document.getElementById("info");
const btnClear = document.getElementById("btnClear");
const tabDaily = document.getElementById("tabDaily");
const tabWeekly = document.getElementById("tabWeekly");

let mode = "daily"; // daily | weekly
let schedules = [];
let reminderTimers = new Map(); // id -> timerId

const dayName = (d) => ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"][Number(d)];

function showInfo(msg) { infoEl.textContent = msg; }

function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(min) {
  const h = String(Math.floor(min / 60)).padStart(2,"0");
  const m = String(min % 60).padStart(2,"0");
  return `${h}:${m}`;
}

function getTodayDay() {
  // JS: 0 Minggu ... 6 Sabtu
  return new Date().getDay();
}

function getNextOccurrence(day, startTimeHHMM) {
  const now = new Date();
  const targetDay = Number(day);
  const [sh, sm] = startTimeHHMM.split(":").map(Number);

  let diff = targetDay - now.getDay();
  if (diff < 0) diff += 7;

  const target = new Date(now);
  target.setDate(now.getDate() + diff);
  target.setHours(sh, sm, 0, 0);

  // kalau hari sama tapi sudah lewat, geser minggu depan
  if (diff === 0 && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  }
  return target;
}

function notify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    new Notification(title, { body });
  } catch {
    // beberapa browser perlu service worker; minimal ini sudah cukup untuk tugas
  }
}

function scheduleReminders() {
  // bersihkan timer lama
  for (const [, t] of reminderTimers) clearTimeout(t);
  reminderTimers.clear();

  // set timer baru (hanya akurat saat app terbuka)
  schedules.forEach(s => {
    const next = getNextOccurrence(s.day, s.startTime);
    const remindAt = new Date(next.getTime() - (s.remindMinutes * 60 * 1000));
    const delay = remindAt.getTime() - Date.now();

    if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
      const timerId = setTimeout(() => {
        notify(
          "Pengingat Kuliah UNIKAMA",
          `${s.course} (${dayName(s.day)} ${s.startTime}) di ${s.room}`
        );
        // setelah bunyi, jadwalkan ulang berikutnya
        loadAndRender();
      }, delay);
      reminderTimers.set(s.id, timerId);
    }
  });
}

function render() {
  listEl.innerHTML = "";

  const today = getTodayDay();
  const view = mode === "daily"
    ? schedules.filter(s => Number(s.day) === today)
    : schedules;

  if (mode === "daily") {
    showInfo(`Mode Harian — Menampilkan jadwal hari ini: ${dayName(today)}`);
  } else {
    showInfo("Mode Mingguan — Menampilkan seluruh jadwal (urut hari & jam).");
  }

  const sorted = [...view].sort((a,b) => {
    const da = Number(a.day), db = Number(b.day);
    if (da !== db) return da - db;
    return parseTimeToMinutes(a.startTime) - parseTimeToMinutes(b.startTime);
  });

  if (sorted.length === 0) {
    listEl.innerHTML = `<div class="info">Belum ada jadwal untuk ditampilkan.</div>`;
    return;
  }

  sorted.forEach(s => {
    const el = document.createElement("div");
    el.className = "item";

    el.innerHTML = `
      <div class="top">
        <div>
          <div class="name">${escapeHtml(s.course)}</div>
          <div class="meta">
            ${dayName(s.day)} • ${s.startTime}–${s.endTime} • Ruang: ${escapeHtml(s.room)}
            ${s.lecturer ? `• Dosen: ${escapeHtml(s.lecturer)}` : ""}
            ${s.semester ? `• Semester: ${escapeHtml(String(s.semester))}` : ""}
          </div>
          <div class="meta">Pengingat: ${s.remindMinutes} menit sebelum</div>
        </div>
        <div class="row">
          <button class="btn" data-edit="${s.id}">Edit</button>
          <button class="btn danger" data-del="${s.id}">Hapus</button>
        </div>
      </div>
    `;

    listEl.appendChild(el);
  });

  // bind tombol edit/hapus
  listEl.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      await dbDelete(id);
      await loadAndRender();
    });
  });

  listEl.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-edit");
      const item = schedules.find(x => x.id === id);
      if (!item) return;

      // isi form untuk edit
      document.getElementById("course").value = item.course;
      document.getElementById("lecturer").value = item.lecturer || "";
      document.getElementById("room").value = item.room;
      document.getElementById("day").value = String(item.day);
      document.getElementById("startTime").value = item.startTime;
      document.getElementById("endTime").value = item.endTime;
      document.getElementById("remindMinutes").value = String(item.remindMinutes);
      document.getElementById("semester").value = item.semester || "";

      form.setAttribute("data-editing", id);
      showInfo("Mode Edit aktif — klik Simpan Jadwal untuk memperbarui.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  scheduleReminders();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

async function loadAndRender() {
  schedules = await dbGetAll();
  render();
}

// ========== Form submit ==========
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const course = document.getElementById("course").value.trim();
  const lecturer = document.getElementById("lecturer").value.trim();
  const room = document.getElementById("room").value.trim();
  const day = Number(document.getElementById("day").value);
  const startTime = document.getElementById("startTime").value;
  const endTime = document.getElementById("endTime").value;
  const remindMinutes = Number(document.getElementById("remindMinutes").value);
  const semesterRaw = document.getElementById("semester").value.trim();

  if (!course || !room || !startTime || !endTime) {
    alert("Mohon lengkapi data jadwal.");
    return;
  }

  if (parseTimeToMinutes(endTime) <= parseTimeToMinutes(startTime)) {
    alert("Jam selesai harus lebih besar dari jam mulai.");
    return;
  }

  const editingId = form.getAttribute("data-editing");
  const id = editingId || crypto.randomUUID();

  const item = {
    id,
    course,
    lecturer: lecturer || "",
    room,
    day,
    startTime,
    endTime,
    remindMinutes,
    semester: semesterRaw || ""
  };

  await dbPut(item);

  form.reset();
  form.removeAttribute("data-editing");
  showInfo("Jadwal tersimpan. Notifikasi akan mengikuti jadwal terbaru.");
  await loadAndRender();
});

// Clear all
btnClear.addEventListener("click", async () => {
  const ok = confirm("Yakin hapus semua jadwal?");
  if (!ok) return;
  await dbClear();
  showInfo("Semua jadwal dihapus.");
  await loadAndRender();
});

// Tabs
tabDaily.addEventListener("click", async () => {
  mode = "daily";
  await loadAndRender();
});
tabWeekly.addEventListener("click", async () => {
  mode = "weekly";
  await loadAndRender();
});

// Init
loadAndRender();
showInfo("Selamat datang! Tambahkan jadwal kuliah agar tersimpan terpusat.");
