const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;
const SERVER_IP = "172.16.0.111";

// Middleware
app.use(cors());
app.use(express.json({ strict: false }));
app.use(express.static(path.join(__dirname, "public")));

// ==================== EXISTING DATA STORAGE ====================
let sensorData = {
  power: [],
  suhu: [],
  ph: [],
  tds: [],
  pompa: [],
};

let latestData = {
  power: {},
  suhu: {},
  ph: {},
  tds: {},
  pompa: { status: false, mode: "manual" },
};

let deviceStatus = {
  isOnline: false,
  lastSeen: null,
  deviceId: null,
  lastSensorUpdate: {}
};

// Timeout dalam milisecond (30 detik)
const DEVICE_TIMEOUT = 30000;
const SENSOR_TIMEOUT = 30000;

// PERBAIKAN: Daftar sensor yang valid
const validSensors = ["power", "suhu", "ph", "tds", "pompa"];

// ==================== ENHANCED SCHEDULER SYSTEM ====================

// Data struktur untuk menyimpan multiple schedules
const pumpSchedules = {};

// Interval untuk setiap device
const scheduleIntervals = {};

// Command queue untuk ESP32
const pumpCommands = {};

// Status pompa per device
const pumpStatuses = {};

// Helper function untuk generate schedule ID
function generateScheduleId() {
  return 'sch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Helper function untuk hitung total seconds
function getTotalSeconds(time) {
  return time.hour * 3600 + time.minute * 60 + time.second;
}

// Helper function untuk cek apakah dalam waktu schedule (support cross-midnight)
function isWithinSchedule(start, end, currentSeconds) {
  const startSeconds = getTotalSeconds(start);
  const endSeconds = getTotalSeconds(end);
  
  if (startSeconds <= endSeconds) {
    // Normal schedule (tidak melewati tengah malam)
    return currentSeconds >= startSeconds && currentSeconds <= endSeconds;
  } else {
    // Cross-midnight schedule (misal: 22:00 - 02:00)
    return currentSeconds >= startSeconds || currentSeconds <= endSeconds;
  }
}

// Fungsi untuk memulai monitoring jadwal
function startPumpScheduleMonitoring(deviceId) {
  // Hentikan interval lama jika ada
  if (scheduleIntervals[deviceId]) {
    clearInterval(scheduleIntervals[deviceId]);
    console.log("[SCHEDULER] Restarting schedule monitoring for " + deviceId);
  }
  
  console.log("[SCHEDULER] Memulai monitoring jadwal untuk " + deviceId);
  
  // Mulai interval baru
  scheduleIntervals[deviceId] = setInterval(function() {
    const deviceSchedule = pumpSchedules[deviceId];
    
    // Cek apakah ada schedule aktif untuk device ini
    if (!deviceSchedule || !deviceSchedule.isActive) {
      return;
    }
    
    const now = new Date();
    const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    
    // Loop melalui semua schedule untuk device ini
    if (deviceSchedule.schedules && deviceSchedule.schedules.length > 0) {
      deviceSchedule.schedules.forEach(function(schedule) {
        if (!schedule.isActive) return;
        
        const isWithin = isWithinSchedule(schedule.start, schedule.end, currentSeconds);
        
        // Logika kontrol
        if (isWithin && !schedule.isRunning) {
          console.log("[SCHEDULER][" + deviceId + "][" + schedule.name + "] WAKTU JADWAL! Mengirim ON (" + 
                      schedule.start.hour + ":" + schedule.start.minute + ":" + schedule.start.second + 
                      " - " + 
                      schedule.end.hour + ":" + schedule.end.minute + ":" + schedule.end.second + ")");
          
          // Kirim perintah ON ke ESP32
          sendPumpCommand(deviceId, true, "auto", schedule.name);
          schedule.isRunning = true;
          schedule.lastTrigger = now.getTime();
          
        } else if (!isWithin && schedule.isRunning) {
          console.log("[SCHEDULER][" + deviceId + "][" + schedule.name + "] JADWAL SELESAI! Mengirim OFF");
          
          // Kirim perintah OFF ke ESP32
          sendPumpCommand(deviceId, false, "auto", schedule.name);
          schedule.isRunning = false;
        }
      });
    }
    
  }, 1000); // Cek setiap detik
}

// Fungsi untuk mengirim perintah ke ESP32 dengan schedule name
function sendPumpCommand(deviceId, turnOn, mode, scheduleName) {
  mode = mode || "auto";
  scheduleName = scheduleName || "unknown";
  
  console.log("[SCHEDULER][" + deviceId + "][" + scheduleName + "] Server mengirim perintah: " + (turnOn ? 'ON' : 'OFF') + " (Mode: " + mode + ")");
  
  // Simpan command untuk diambil ESP32
  pumpCommands[deviceId] = {
    command: turnOn ? 'on' : 'off',
    mode: mode,
    scheduleName: scheduleName,
    timestamp: new Date().toISOString(),
    source: 'server_schedule'
  };
  
  // Update status di memory
  pumpStatuses[deviceId] = {
    status: turnOn,
    mode: mode,
    scheduleName: scheduleName,
    lastUpdate: new Date(),
    source: 'server_schedule'
  };
  
  // Juga update latestData.pompa untuk konsistensi
  latestData.pompa = {
    status: turnOn,
    mode: mode,
    scheduleName: scheduleName,
    last_updated: new Date().toISOString(),
    controlled_by: "server-schedule",
    deviceId: deviceId,
    timestamp: new Date().toLocaleTimeString(),
    unix_timestamp: Date.now()
  };
}

// Fungsi untuk mematikan semua jadwal
function stopAllSchedules() {
  console.log('[SCHEDULER] Menghentikan semua scheduler...');
  
  Object.keys(scheduleIntervals).forEach(function(deviceId) {
    clearInterval(scheduleIntervals[deviceId]);
    
    // Matikan pompa yang sedang berjalan oleh schedule
    const deviceSchedule = pumpSchedules[deviceId];
    if (deviceSchedule && deviceSchedule.schedules) {
      deviceSchedule.schedules.forEach(function(schedule) {
        if (schedule.isRunning) {
          console.log('[SCHEDULER] Mematikan pompa ' + deviceId + ' (' + schedule.name + ') karena server shutdown');
          sendPumpCommand(deviceId, false, 'manual', schedule.name);
          schedule.isRunning = false;
        }
      });
    }
  });
  
  // Kosongkan intervals
  Object.keys(scheduleIntervals).forEach(function(key) {
    delete scheduleIntervals[key];
  });
}

// Inisialisasi scheduler saat server start
function initializeSchedules() {
  console.log('[SCHEDULER] Inisialisasi enhanced scheduler system...');
  console.log('[SCHEDULER] Support: Multiple schedules, Cross-midnight, Flexible timing');
}

// Panggil saat server start
initializeSchedules();

// Handle graceful shutdown
process.on('SIGINT', function() {
  stopAllSchedules();
  process.exit(0);
});

process.on('SIGTERM', function() {
  stopAllSchedules();
  process.exit(0);
});

// ==================== EXISTING FUNCTIONS (SAMA) ====================

// PERBAIKAN: Function to validate data per sensor type
function validateSensorData(data, type) {
  var validated = {};
  
  // Copy semua property dari data
  for (var key in data) {
    if (data.hasOwnProperty(key)) {
      validated[key] = data[key];
    }
  }

  switch (type) {
    case "power":
      if (isNaN(validated.voltage) || !isFinite(validated.voltage))
        validated.voltage = 0;
      if (isNaN(validated.current) || !isFinite(validated.current))
        validated.current = 0;
      if (isNaN(validated.power) || !isFinite(validated.power))
        validated.power = 0;
      if (isNaN(validated.energy) || !isFinite(validated.energy))
        validated.energy = 0;
      if (isNaN(validated.frequency) || !isFinite(validated.frequency))
        validated.frequency = 0;
      if (isNaN(validated.power_factor) || !isFinite(validated.power_factor))
        validated.power_factor = 0;
      break;

    case "suhu":
      if (isNaN(validated.suhu) || !isFinite(validated.suhu))
        validated.suhu = 0;
      if (isNaN(validated.kelembaban) || !isFinite(validated.kelembaban))
        validated.kelembaban = 0;
      if (isNaN(validated.heat_index) || !isFinite(validated.heat_index))
        validated.heat_index = 0;
      break;

    case "ph":
      if (isNaN(validated.ph) || !isFinite(validated.ph)) validated.ph = 7.0;
      break;

    case "tds":
      if (isNaN(validated.tds) || !isFinite(validated.tds)) validated.tds = 0;
      if (isNaN(validated.suhu_air) || !isFinite(validated.suhu_air))
        validated.suhu_air = 0;
      break;

    case "pompa":
      if (typeof validated.status !== "boolean") validated.status = false;
      if (!validated.mode) validated.mode = "manual";
      break;
  }

  return validated;
}

// PERBAIKAN: Check device status dengan sensor-based tracking
function checkDeviceStatus() {
  const now = Date.now();
  
  // Cek jika ada sensor yang update dalam 30 detik terakhir
  var recentUpdates = false;
  var lastSensorUpdate = deviceStatus.lastSensorUpdate;
  
  for (var sensor in lastSensorUpdate) {
    if (lastSensorUpdate.hasOwnProperty(sensor)) {
      var timestamp = lastSensorUpdate[sensor];
      if (timestamp && (now - timestamp < DEVICE_TIMEOUT)) {
        recentUpdates = true;
        break;
      }
    }
  }
  
  if (!recentUpdates && deviceStatus.isOnline) {
    deviceStatus.isOnline = false;
    console.log("⚠️  Device " + deviceStatus.deviceId + " is now offline");
  } else if (recentUpdates && !deviceStatus.isOnline) {
    deviceStatus.isOnline = true;
    console.log("✅ Device " + deviceStatus.deviceId + " is now online");
  }
}

// Check status every 5 seconds
setInterval(checkDeviceStatus, 5000);

// ==================== API ENDPOINTS ====================

// PERBAIKAN: Route untuk terima data dari ESP32 per sensor type
app.post("/api/data/:sensorType", function(req, res) {
  const sensorType = req.params.sensorType;
  
  // Validasi sensor type
  if (validSensors.indexOf(sensorType) === -1) {
    return res.status(400).json({
      error: "Invalid sensor type",
      message: "Sensor type must be one of: " + validSensors.join(", "),
      server_ip: SERVER_IP
    });
  }

  console.log("📨 [" + sensorType.toUpperCase() + "] Data received:", req.body);

  try {
    const validatedData = validateSensorData(req.body, sensorType);

    // PERBAIKAN: Update device status dengan sensor-specific tracking
    const now = Date.now();
    deviceStatus.isOnline = true;
    deviceStatus.lastSeen = now;
    deviceStatus.lastSensorUpdate[sensorType] = now;
    deviceStatus.deviceId = req.body.deviceId || ("ESP32_" + sensorType.toUpperCase());

    // Tambah timestamp
    const dataWithTime = {
      ...validatedData,
      timestamp: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      deviceId: deviceStatus.deviceId,
      sensorType: sensorType,
      unix_timestamp: now,
    };

    // Simpan data
    latestData[sensorType] = dataWithTime;
    
    // Pastikan array ada sebelum push
    if (!sensorData[sensorType]) {
      sensorData[sensorType] = [];
    }
    
    sensorData[sensorType].push(dataWithTime);

    // Simpan hanya 100 data terakhir per sensor
    if (sensorData[sensorType].length > 100) {
      sensorData[sensorType] = sensorData[sensorType].slice(-100);
    }

    console.log("✅ [" + sensorType.toUpperCase() + "] Data saved from " + deviceStatus.deviceId);

    res.json({
      message: "Data " + sensorType + " received OK!",
      status: "success",
      device_status: "online",
      server_ip: SERVER_IP,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("❌ [" + sensorType.toUpperCase() + "] Error:", error);
    res.status(400).json({
      error: "Invalid data format",
      message: error.message,
      server_ip: SERVER_IP
    });
  }
});

// PERBAIKAN: Kontrol Pompa (existing - tetap dipertahankan)
app.post("/api/pompa/control", function(req, res) {
  const body = req.body;
  const action = body.action;
  const mode = body.mode || "manual";
  
  console.log("🔧 Pompa control: " + action + ", mode: " + mode);

  const now = Date.now();
  deviceStatus.isOnline = true;
  deviceStatus.lastSeen = now;
  deviceStatus.lastSensorUpdate.pompa = now;

  latestData.pompa = {
    status: action === "on",
    mode: mode,
    last_updated: new Date().toISOString(),
    controlled_by: "web-dashboard",
    deviceId: deviceStatus.deviceId || "WEB_CONTROL",
    timestamp: new Date().toLocaleTimeString(),
    unix_timestamp: now
  };

  // Pastikan array pompa ada
  if (!sensorData.pompa) {
    sensorData.pompa = [];
  }
  
  // Simpan ke history
  sensorData.pompa.push(latestData.pompa);
  if (sensorData.pompa.length > 100) {
    sensorData.pompa = sensorData.pompa.slice(-100);
  }

  res.json({
    status: "success",
    message: "Pompa " + (action === "on" ? "dinyalakan" : "dimatikan"),
    data: latestData.pompa,
  });
});

// ==================== ENHANCED SCHEDULER ENDPOINTS ====================

// API untuk menyimpan multiple schedules dari dashboard
app.post("/api/pompa/schedule", function(req, res) {
  try {
    const body = req.body;
    const deviceId = body.deviceId;
    const schedules = body.schedules; // Array of schedules
    const action = body.action || 'set';
    
    console.log("📅 Menerima " + schedules.length + " jadwal untuk " + deviceId + ":", schedules);
    
    if (!deviceId || !schedules || !Array.isArray(schedules)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID dan array schedules diperlukan' 
      });
    }
    
    // Validasi semua schedule
    for (let i = 0; i < schedules.length; i++) {
      const schedule = schedules[i];
      
      if (!schedule.name || !schedule.start || !schedule.end) {
        return res.status(400).json({ 
          success: false, 
          message: 'Setiap schedule harus memiliki name, start, dan end' 
        });
      }
      
      // Validasi waktu
      if (schedule.start.hour < 0 || schedule.start.hour > 23 ||
          schedule.end.hour < 0 || schedule.end.hour > 23 ||
          schedule.start.minute < 0 || schedule.start.minute > 59 ||
          schedule.end.minute < 0 || schedule.end.minute > 59 ||
          schedule.start.second < 0 || schedule.start.second > 59 ||
          schedule.end.second < 0 || schedule.end.second > 59) {
        return res.status(400).json({ 
          success: false, 
          message: 'Format waktu tidak valid untuk schedule: ' + schedule.name 
        });
      }
      
      // Generate ID jika belum ada
      if (!schedule.id) {
        schedule.id = generateScheduleId();
      }
      
      // Set default values
      schedule.isActive = schedule.isActive !== undefined ? schedule.isActive : true;
      schedule.isRunning = false;
    }
    
    // Simpan schedules
    pumpSchedules[deviceId] = {
      schedules: schedules,
      isActive: true,
      lastUpdated: new Date(),
      createdBy: req.ip || 'dashboard'
    };
    
    // Start monitoring
    startPumpScheduleMonitoring(deviceId);
    
    // Pastikan array pompa ada
    if (!sensorData.pompa) {
      sensorData.pompa = [];
    }
    
    // Log ke history pompa
    const scheduleLog = {
      deviceId: deviceId,
      action: "set_multiple_schedules",
      scheduleCount: schedules.length,
      timestamp: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unix_timestamp: Date.now()
    };
    
    sensorData.pompa.push(scheduleLog);
    
    res.json({ 
      success: true, 
      message: schedules.length + ' jadwal berhasil disimpan di server',
      schedules: pumpSchedules[deviceId],
      nextCheck: new Date(Date.now() + 1000).toISOString(),
      serverTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error saving schedule:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// API untuk mendapatkan semua schedules per device
app.get("/api/pompa/schedule/:deviceId", function(req, res) {
  const deviceId = req.params.deviceId;
  const deviceSchedule = pumpSchedules[deviceId] || null;
  
  const now = new Date();
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  
  var response = {
    success: true,
    deviceId: deviceId,
    exists: !!deviceSchedule,
    schedules: [],
    serverTime: now.toISOString(),
    currentTime: {
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      totalSeconds: currentSeconds
    }
  };
  
  if (deviceSchedule && deviceSchedule.schedules) {
    // Process each schedule
    deviceSchedule.schedules.forEach(function(schedule) {
      const startSeconds = getTotalSeconds(schedule.start);
      const endSeconds = getTotalSeconds(schedule.end);
      const isWithin = isWithinSchedule(schedule.start, schedule.end, currentSeconds);
      
      let status = "inactive";
      let nextRun = null;
      
      if (schedule.isActive) {
        if (schedule.isRunning) {
          status = "running";
        } else if (isWithin) {
          status = "within_schedule";
        } else {
          status = "waiting";
          
          // Hitung waktu sampai jadwal berikutnya
          if (startSeconds > currentSeconds) {
            nextRun = startSeconds - currentSeconds;
          } else {
            // Jika sudah lewat hari ini, hitung untuk besok
            nextRun = (86400 - currentSeconds) + startSeconds;
          }
        }
      }
      
      response.schedules.push({
        id: schedule.id,
        name: schedule.name,
        start: schedule.start,
        end: schedule.end,
        isActive: schedule.isActive,
        isRunning: schedule.isRunning,
        status: status,
        isWithinSchedule: isWithin,
        nextRunSeconds: nextRun,
        startSeconds: startSeconds,
        endSeconds: endSeconds
      });
    });
  }
  
  res.json(response);
});

// API untuk menghapus semua schedules atau schedule tertentu
app.delete("/api/pompa/schedule/:deviceId", function(req, res) {
  const deviceId = req.params.deviceId;
  const action = req.query.action || 'disable'; // 'disable', 'delete', atau 'delete_single'
  const scheduleId = req.query.scheduleId; // Untuk delete single schedule
  
  if (action === 'disable' && pumpSchedules[deviceId]) {
    // Nonaktifkan semua schedules untuk device ini
    pumpSchedules[deviceId].isActive = false;
    
    // Matikan pompa yang sedang berjalan oleh schedule
    if (pumpSchedules[deviceId].schedules) {
      pumpSchedules[deviceId].schedules.forEach(function(schedule) {
        if (schedule.isRunning) {
          sendPumpCommand(deviceId, false, 'manual', schedule.name);
          schedule.isRunning = false;
        }
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Semua jadwal dinonaktifkan',
      schedules: pumpSchedules[deviceId]
    });
    
  } else if (action === 'delete_single' && scheduleId && pumpSchedules[deviceId]) {
    // Hapus schedule tertentu
    const originalLength = pumpSchedules[deviceId].schedules ? pumpSchedules[deviceId].schedules.length : 0;
    
    if (pumpSchedules[deviceId].schedules) {
      pumpSchedules[deviceId].schedules = pumpSchedules[deviceId].schedules.filter(
        function(schedule) { return schedule.id !== scheduleId; }
      );
    }
    
    // FIX: Tanpa optional chaining
    const newLength = pumpSchedules[deviceId] && pumpSchedules[deviceId].schedules ? 
                      pumpSchedules[deviceId].schedules.length : 0;
    
    if (newLength === 0) {
      // Jika tidak ada schedule lagi, hapus seluruh device schedule
      delete pumpSchedules[deviceId];
      if (scheduleIntervals[deviceId]) {
        clearInterval(scheduleIntervals[deviceId]);
        delete scheduleIntervals[deviceId];
      }
    }
    
    res.json({ 
      success: true, 
      message: 'Jadwal berhasil dihapus',
      deleted: originalLength !== newLength
    });
    
  } else {
    // Hapus semua schedules untuk device ini
    delete pumpSchedules[deviceId];
    
    if (scheduleIntervals[deviceId]) {
      clearInterval(scheduleIntervals[deviceId]);
      delete scheduleIntervals[deviceId];
    }
    
    res.json({ 
      success: true, 
      message: 'Semua jadwal dihapus'
    });
  }
});

// ==================== COMPATIBILITY ENDPOINTS (BARU) ====================

// API untuk menyimpan single schedule (kompatibilitas dengan pompa.html lama)
app.post("/api/pompa/schedules", function(req, res) {
  try {
    const body = req.body;
    const deviceId = body.deviceId;
    const scheduleData = body.schedule; // Single schedule object
    const action = body.action || 'set';
    
    console.log("📅 Menerima single schedule untuk " + deviceId + ":", scheduleData);
    
    if (!deviceId || !scheduleData) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID dan schedule diperlukan' 
      });
    }
    
    // Validasi scheduleId dari data (1 untuk pagi, 2 untuk sore, atau custom)
    const scheduleId = scheduleData.scheduleId || 1;
    
    // Validasi waktu
    if (!scheduleData.start || !scheduleData.end) {
      return res.status(400).json({ 
        success: false, 
        message: 'Schedule harus memiliki start dan end' 
      });
    }
    
    // Validasi format waktu
    if (scheduleData.start.hour < 0 || scheduleData.start.hour > 23 ||
        scheduleData.end.hour < 0 || scheduleData.end.hour > 23 ||
        scheduleData.start.minute < 0 || scheduleData.start.minute > 59 ||
        scheduleData.end.minute < 0 || scheduleData.end.minute > 59 ||
        scheduleData.start.second < 0 || scheduleData.start.second > 59 ||
        scheduleData.end.second < 0 || scheduleData.end.second > 59) {
      return res.status(400).json({ 
        success: false, 
        message: 'Format waktu tidak valid' 
      });
    }
    
    // Inisialisasi jika belum ada
    if (!pumpSchedules[deviceId]) {
      pumpSchedules[deviceId] = {
        schedules: [],
        isActive: true,
        lastUpdated: new Date(),
        createdBy: req.ip || 'dashboard'
      };
    }
    
    // Cek apakah schedule dengan ID ini sudah ada
    let existingScheduleIndex = -1;
    if (pumpSchedules[deviceId].schedules) {
      existingScheduleIndex = pumpSchedules[deviceId].schedules.findIndex(
        s => s.scheduleId === scheduleId
      );
    }
    
    // Buat schedule object baru
    const newSchedule = {
      id: generateScheduleId(),
      scheduleId: scheduleId,
      name: scheduleData.name || (scheduleId === 1 ? "Jadwal Pagi" : "Jadwal Sore"),
      start: scheduleData.start,
      end: scheduleData.end,
      isActive: scheduleData.enabled !== undefined ? scheduleData.enabled : true,
      isRunning: false,
      lastTrigger: null
    };
    
    // Update atau tambah schedule
    if (existingScheduleIndex >= 0) {
      // Update existing
      pumpSchedules[deviceId].schedules[existingScheduleIndex] = newSchedule;
    } else {
      // Tambah baru
      if (!pumpSchedules[deviceId].schedules) {
        pumpSchedules[deviceId].schedules = [];
      }
      pumpSchedules[deviceId].schedules.push(newSchedule);
    }
    
    // Pastikan array tidak kosong
    if (pumpSchedules[deviceId].schedules.length === 0) {
      pumpSchedules[deviceId].schedules.push(newSchedule);
    }
    
    // Update lastUpdated
    pumpSchedules[deviceId].lastUpdated = new Date();
    pumpSchedules[deviceId].isActive = true;
    
    // Start monitoring
    startPumpScheduleMonitoring(deviceId);
    
    // Log ke history pompa
    if (!sensorData.pompa) {
      sensorData.pompa = [];
    }
    
    const scheduleLog = {
      deviceId: deviceId,
      action: "set_single_schedule",
      scheduleId: scheduleId,
      scheduleName: newSchedule.name,
      timestamp: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
      unix_timestamp: Date.now()
    };
    
    sensorData.pompa.push(scheduleLog);
    
    res.json({ 
      success: true, 
      message: 'Jadwal berhasil disimpan di server',
      schedule: newSchedule,
      scheduleId: scheduleId,
      serverTime: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error saving single schedule:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message 
    });
  }
});

// API untuk mendapatkan schedules dalam format kompatibel
app.get("/api/pompa/schedules/:deviceId", function(req, res) {
  const deviceId = req.params.deviceId;
  const deviceSchedule = pumpSchedules[deviceId] || null;
  
  const now = new Date();
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  
  var response = {
    success: true,
    deviceId: deviceId,
    exists: !!deviceSchedule,
    schedules: [],
    hasSchedules: false,
    serverTime: now.toISOString(),
    currentTime: {
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      totalSeconds: currentSeconds
    }
  };
  
  if (deviceSchedule && deviceSchedule.schedules && deviceSchedule.schedules.length > 0) {
    response.hasSchedules = true;
    response.schedules = deviceSchedule.schedules;
    
    // Hitung status
    let anyScheduleRunning = false;
    let anyScheduleWithin = false;
    let nextRunTime = null;
    
    deviceSchedule.schedules.forEach(function(schedule) {
      if (schedule.isActive) {
        const isWithin = isWithinSchedule(schedule.start, schedule.end, currentSeconds);
        
        if (schedule.isRunning) {
          anyScheduleRunning = true;
        } else if (isWithin) {
          anyScheduleWithin = true;
        }
        
        // Hitung next run untuk schedule yang belum running
        if (!schedule.isRunning && schedule.isActive) {
          const startSeconds = getTotalSeconds(schedule.start);
          let nextRun = null;
          
          if (startSeconds > currentSeconds) {
            nextRun = startSeconds - currentSeconds;
          } else {
            // Jika sudah lewat hari ini, hitung untuk besok
            nextRun = (86400 - currentSeconds) + startSeconds;
          }
          
          if (!nextRunTime || nextRun < nextRunTime) {
            nextRunTime = nextRun;
          }
        }
      }
    });
    
    // Set overall status
    if (anyScheduleRunning) {
      response.status = "running";
    } else if (anyScheduleWithin) {
      response.status = "within_schedule";
    } else if (nextRunTime) {
      response.status = "waiting";
      response.nextRunSeconds = nextRunTime;
    } else {
      response.status = "inactive";
    }
  } else {
    response.status = "no_schedule";
  }
  
  res.json(response);
});

// API untuk menghapus semua schedules (kompatibilitas)
app.delete("/api/pompa/schedules/:deviceId", function(req, res) {
  const deviceId = req.params.deviceId;
  const action = req.query.action || 'delete_all';
  
  if (action === 'delete_all') {
    // Hapus semua schedules untuk device ini
    delete pumpSchedules[deviceId];
    
    if (scheduleIntervals[deviceId]) {
      clearInterval(scheduleIntervals[deviceId]);
      delete scheduleIntervals[deviceId];
    }
    
    // Matikan pompa jika sedang menyala oleh schedule
    sendPumpCommand(deviceId, false, 'manual', 'schedule_clear');
    
    res.json({ 
      success: true, 
      message: 'Semua jadwal dihapus dari server'
    });
  } else {
    res.status(400).json({ 
      success: false, 
      message: 'Action tidak valid' 
    });
  }
});

// API untuk ESP32 mengambil perintah dari server (SAMA)
app.get("/api/pompa/command/:deviceId", function(req, res) {
  const deviceId = req.params.deviceId;
  
  // Periksa apakah ada perintah yang menunggu
  const pendingCommand = pumpCommands[deviceId];
  
  if (pendingCommand) {
    console.log("📤 Mengirim perintah ke " + deviceId + ": " + pendingCommand.command);
    
    // Hapus setelah dikirim (one-time command)
    const response = JSON.parse(JSON.stringify(pendingCommand));
    delete pumpCommands[deviceId];
    
    res.json({ 
      success: true, 
      hasCommand: true,
      command: response,
      serverTime: new Date().toISOString()
    });
    
  } else {
    // Tidak ada perintah
    res.json({ 
      success: true, 
      hasCommand: false,
      message: 'Tidak ada perintah',
      serverTime: new Date().toISOString()
    });
  }
});

// API untuk melihat semua jadwal aktif (admin)
app.get("/api/pompa/schedules", function(req, res) {
  res.json({
    success: true,
    schedules: pumpSchedules,
    intervals: Object.keys(scheduleIntervals),
    serverTime: new Date().toISOString(),
    totalDevices: Object.keys(pumpSchedules).length
  });
});

// API untuk status scheduler
app.get("/api/pompa/scheduler/status", function(req, res) {
  const now = new Date();
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  
  const scheduleStatus = {};
  Object.keys(pumpSchedules).forEach(function(deviceId) {
    const deviceSchedule = pumpSchedules[deviceId];
    if (deviceSchedule) {
      const scheduleCount = deviceSchedule.schedules ? deviceSchedule.schedules.length : 0;
      const activeSchedules = deviceSchedule.schedules ? 
        deviceSchedule.schedules.filter(function(s) { return s.isActive; }).length : 0;
      const runningSchedules = deviceSchedule.schedules ? 
        deviceSchedule.schedules.filter(function(s) { return s.isRunning; }).length : 0;
      
      scheduleStatus[deviceId] = {
        isActive: deviceSchedule.isActive,
        scheduleCount: scheduleCount,
        activeSchedules: activeSchedules,
        runningSchedules: runningSchedules,
        schedules: deviceSchedule.schedules ? deviceSchedule.schedules.map(function(schedule) {
          const isWithin = isWithinSchedule(schedule.start, schedule.end, currentSeconds);
          
          return {
            name: schedule.name,
            isActive: schedule.isActive,
            isRunning: schedule.isRunning,
            isWithinSchedule: isWithin,
            startTime: schedule.start.hour + ':' + schedule.start.minute + ':' + schedule.start.second,
            endTime: schedule.end.hour + ':' + schedule.end.minute + ':' + schedule.end.second
          };
        }) : []
      };
    }
  });
  
  res.json({
    success: true,
    schedulerActive: Object.keys(scheduleIntervals).length > 0,
    scheduleStatus: scheduleStatus,
    currentTime: {
      hour: now.getHours(),
      minute: now.getMinutes(),
      second: now.getSeconds(),
      totalSeconds: currentSeconds
    },
    serverTime: now.toISOString()
  });
});

// ==================== EXISTING ENDPOINTS ====================

// PERBAIKAN: Route untuk ambil data terbaru per sensor
app.get("/api/latest/:sensorType", function(req, res) {
  const sensorType = req.params.sensorType;
  
  if (validSensors.indexOf(sensorType) === -1) {
    return res.status(400).json({
      error: "Invalid sensor type",
      message: "Sensor type must be one of: " + validSensors.join(", ")
    });
  }

  const response = {
    ...latestData[sensorType],
    device_status: deviceStatus,
    server_ip: SERVER_IP,
    sensor_type: sensorType,
    last_update: deviceStatus.lastSensorUpdate[sensorType] || null
  };
  
  res.json(response);
});

// PERBAIKAN: Route untuk ambil semua data per sensor
app.get("/api/all/:sensorType", function(req, res) {
  const sensorType = req.params.sensorType;
  
  if (validSensors.indexOf(sensorType) === -1) {
    return res.status(400).json({
      error: "Invalid sensor type",
      message: "Sensor type must be one of: " + validSensors.join(", ")
    });
  }

  // Pastikan sensorData ada untuk sensor type ini
  if (!sensorData[sensorType]) {
    sensorData[sensorType] = [];
  }

  res.json({
    data: sensorData[sensorType],
    count: sensorData[sensorType].length,
    sensor_type: sensorType,
    server_ip: SERVER_IP,
    device_status: deviceStatus
  });
});

// PERBAIKAN: Route untuk ambil status device saja
app.get("/api/status", function(req, res) {
  res.json(deviceStatus);
});

// PERBAIKAN: Health check endpoint
app.get("/api/health", function(req, res) {
  const sensorStatus = {};
  var onlineSensors = 0;
  
  validSensors.forEach(function(sensor) {
    const isOnline = deviceStatus.lastSensorUpdate[sensor] && 
                    (Date.now() - deviceStatus.lastSensorUpdate[sensor] < SENSOR_TIMEOUT);
    sensorStatus[sensor] = isOnline ? "online" : "offline";
    if (isOnline) onlineSensors++;
  });

  res.json({
    status: "healthy",
    server_ip: SERVER_IP,
    port: PORT,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    device_status: deviceStatus,
    sensors_online: onlineSensors,
    sensors_total: validSensors.length,
    sensor_status: sensorStatus,
    scheduler: {
      active: Object.keys(scheduleIntervals).length > 0,
      schedules: Object.keys(pumpSchedules).length
    }
  });
});

// PERBAIKAN: Endpoint untuk status semua sensor
app.get("/api/status/all", function(req, res) {
  const sensorStatus = {};
  const now = Date.now();
  
  validSensors.forEach(function(sensorType) {
    const lastUpdate = deviceStatus.lastSensorUpdate[sensorType];
    const isOnline = lastUpdate && (now - lastUpdate < SENSOR_TIMEOUT);
    
    // Pastikan sensorData ada untuk sensor type ini
    if (!sensorData[sensorType]) {
      sensorData[sensorType] = [];
    }
    
    sensorStatus[sensorType] = {
      online: isOnline,
      lastUpdate: lastUpdate,
      data: latestData[sensorType] || {},
      history_count: sensorData[sensorType].length
    };
  });

  res.json({
    server: "online",
    timestamp: new Date().toISOString(),
    device_status: deviceStatus,
    sensors: sensorStatus,
    scheduler: {
      active: Object.keys(scheduleIntervals).length > 0,
      schedules: pumpSchedules
    }
  });
});

// PERBAIKAN: Endpoint untuk device info
app.get("/api/device/info", function(req, res) {
  const sensorUpdates = {};
  const now = Date.now();
  
  validSensors.forEach(function(sensor) {
    const lastUpdate = deviceStatus.lastSensorUpdate[sensor];
    const ageSeconds = lastUpdate ? Math.round((now - lastUpdate) / 1000) : null;
    
    sensorUpdates[sensor] = {
      last_update: lastUpdate,
      age_seconds: ageSeconds,
      status: lastUpdate && (now - lastUpdate < SENSOR_TIMEOUT) ? "online" : "offline"
    };
  });

  res.json({
    device_id: deviceStatus.deviceId,
    is_online: deviceStatus.isOnline,
    last_seen: deviceStatus.lastSeen,
    server_uptime: process.uptime(),
    sensor_updates: sensorUpdates,
    server_ip: SERVER_IP,
    scheduler: {
      schedules: Object.keys(pumpSchedules).length,
      active_schedules: Object.keys(pumpSchedules).filter(function(id) { 
        return pumpSchedules[id] && pumpSchedules[id].isActive; 
      }).length
    }
  });
});

// PERBAIKAN: Route untuk reset data per sensor atau semua
app.delete("/api/reset/:sensorType?", function(req, res) {
  const sensorType = req.params.sensorType;
  
  if (sensorType) {
    // Reset sensor tertentu
    if (validSensors.indexOf(sensorType) === -1) {
      return res.status(400).json({
        error: "Invalid sensor type",
        message: "Sensor type must be one of: " + validSensors.join(", ")
      });
    }
    
    // Pastikan array ada sebelum reset
    sensorData[sensorType] = [];
    latestData[sensorType] = sensorType === "pompa" ? { status: false, mode: "manual" } : {};
    deviceStatus.lastSensorUpdate[sensorType] = null;
    console.log("🔄 Data " + sensorType + " reset by client");
    
    res.json({
      message: "Data " + sensorType + " reset successfully",
      server_ip: SERVER_IP
    });
  } else {
    // Reset semua data
    validSensors.forEach(function(sensor) {
      sensorData[sensor] = [];
      latestData[sensor] = sensor === "pompa" ? { status: false, mode: "manual" } : {};
      deviceStatus.lastSensorUpdate[sensor] = null;
    });
    deviceStatus.isOnline = false;
    deviceStatus.lastSeen = null;
    console.log("🔄 All data reset by client");
    
    res.json({
      message: "All sensor data reset successfully",
      server_ip: SERVER_IP
    });
  }
});

// Serve static files dari public folder
app.use(express.static("public"));

// Serve halaman dashboard
app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle 404
app.use(function(req, res) {
  res.status(404).json({
    error: "Endpoint not found",
    server_ip: SERVER_IP,
    available_endpoints: [
      "GET /",
      "GET /api/health",
      "GET /api/status/all", 
      "GET /api/device/info",
      "POST /api/data/:sensorType (power|suhu|ph|tds|pompa)",
      "GET /api/latest/:sensorType",
      "GET /api/all/:sensorType",
      "POST /api/pompa/control",
      "DELETE /api/reset/:sensorType?",
      // New scheduler endpoints
      "POST /api/pompa/schedule",
      "GET /api/pompa/schedule/:deviceId",
      "DELETE /api/pompa/schedule/:deviceId",
      "POST /api/pompa/schedules (compatibility)",
      "GET /api/pompa/schedules/:deviceId (compatibility)",
      "DELETE /api/pompa/schedules/:deviceId (compatibility)",
      "GET /api/pompa/command/:deviceId",
      "GET /api/pompa/schedules",
      "GET /api/pompa/scheduler/status"
    ]
  });
});

// Jalankan server
app.listen(PORT, "0.0.0.0", function() {
  console.log("=".repeat(60));
  console.log("🏠 Ruang Kebon Smart Farming Dashboard");
  console.log("📍 Server: http://" + SERVER_IP + ":" + PORT);
  console.log("📍 Local:  http://localhost:" + PORT);
  console.log("=".repeat(60));
  console.log("📋 Available Endpoints:");
  console.log("   POST /api/data/power    - Receive power data");
  console.log("   POST /api/data/suhu     - Receive temperature data");
  console.log("   POST /api/data/ph       - Receive pH data");
  console.log("   POST /api/data/tds      - Receive TDS data");
  console.log("   POST /api/data/pompa    - Receive pump status");
  console.log("   GET  /api/status/all    - All sensors status");
  console.log("   GET  /api/device/info   - Device information");
  console.log("   GET  /api/health        - Server health check");
  console.log("=".repeat(60));
  console.log("⏰ ENHANCED SCHEDULER ENDPOINTS:");
  console.log("   POST /api/pompa/schedule     - Set multiple schedules");
  console.log("   GET  /api/pompa/schedule/:id - Get all schedules");
  console.log("   DEL  /api/pompa/schedule/:id - Delete schedules");
  console.log("   POST /api/pompa/schedules    - Single schedule (compat)");
  console.log("   GET  /api/pompa/schedules/:id- Get schedules (compat)");
  console.log("   DEL  /api/pompa/schedules/:id- Delete all schedules");
  console.log("   GET  /api/pompa/command/:id  - ESP32 get command");
  console.log("   GET  /api/pompa/schedules    - All schedules");
  console.log("=".repeat(60));
  console.log("🔧 Features: Multiple schedules, Cross-midnight support");
  console.log("⏰ Flexible timing: Any start/end time combination");
  console.log("📊 Data Storage: 100 latest readings per sensor");
  console.log("=".repeat(60));
});
