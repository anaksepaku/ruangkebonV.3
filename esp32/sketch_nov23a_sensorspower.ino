#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PZEM004Tv30.h>

// WiFi Settings
const char* ssid = "Home";
const char* password = "bayardulu";

// PERBAIKAN: Define server URL dengan benar
#define SERVER_BASE_URL "http://172.16.0.76:3000"

// PZEM Setup
PZEM004Tv30 pzem(Serial2, 16, 17); // RX=16, TX=17

// Device ID
String deviceID;

// PERBAIKAN: Counter untuk failed readings
int failedReadings = 0;
const int MAX_FAILED_READINGS = 3;

void setup() {
  Serial.begin(115200);
  
  // Tunggu serial connection
  while (!Serial) {
    delay(100);
  }
  
  Serial.println();
  Serial.println("🚀 Starting PZEM-004T Energy Monitor...");
  Serial.println("==========================================");
  
  // Initialize Serial2 for PZEM
  Serial2.begin(9600, SERIAL_8N1, 16, 17);
  
  // Generate Device ID
  deviceID = getDeviceID();
  Serial.println("Device ID: " + deviceID);
  
  // Test PZEM Connection secara mendalam
  Serial.println();
  Serial.println("🔍 Testing PZEM Connection...");
  testPZEMConnection();
  
  // Connect to WiFi
  Serial.println();
  connectToWiFi();
  
  Serial.println();
  Serial.println("✅ System Ready!");
  Serial.println("==========================================");
}

void loop() {
  // Check WiFi connection
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ WiFi disconnected! Reconnecting...");
    connectToWiFi();
    delay(2000);
    return;
  }
  
  // Read and send sensor data
  readAndSendData();
  
  delay(5000); // Send every 5 seconds
}

// Function to generate unique Device ID
String getDeviceID() {
  uint64_t chipid = ESP.getEfuseMac();
  String id = "ESP32_" + String((uint32_t)(chipid >> 32), HEX) + String((uint32_t)chipid, HEX);
  id.toUpperCase();
  return id;
}

// Function to check if value is valid
bool isValid(float value) {
  if (isnan(value)) {
    return false;
  }
  if (!isfinite(value)) {
    return false;
  }
  return true;
}

// Test PZEM connection secara detail
void testPZEMConnection() {
  Serial.println("📌 PZEM Pin Configuration:");
  Serial.println("   PZEM TX (Green)  → ESP32 GPIO16 (RX2)");
  Serial.println("   PZEM RX (Yellow) → ESP32 GPIO17 (TX2)");
  Serial.println("   PZEM VCC (Red)   → ESP32 5V");
  Serial.println("   PZEM GND (Black) → ESP32 GND");
  Serial.println();
  
  // Test multiple readings
  bool pzemConnected = false;
  for (int i = 1; i <= 5; i++) {
    Serial.print("Test #" + String(i) + ": ");
    
    float voltage = pzem.voltage();
    float current = pzem.current();
    
    if (!isValid(voltage) || voltage == NAN) {
      Serial.println("❌ FAILED - No response from PZEM");
    } else if (voltage > 0) {
      Serial.print("V=" + String(voltage, 1) + "V, ");
      Serial.print("I=" + String(current, 3) + "A");
      Serial.println(" ✅ SUCCESS");
      pzemConnected = true;
      break;
    } else {
      Serial.println(" ⚠️  No Voltage (check AC power connection)");
    }
    
    delay(2000);
  }
  
  if (!pzemConnected) {
    Serial.println("💡 PZEM not connected, but ESP32 will continue sending device status");
  }
}

// WiFi connection
void connectToWiFi() {
  Serial.println("📡 Connecting to WiFi: " + String(ssid));
  
  WiFi.disconnect();
  delay(1000);
  
  WiFi.begin(ssid, password);
  int attempts = 0;
  
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    Serial.println("IP Address: " + WiFi.localIP().toString());
    Serial.println("RSSI: " + String(WiFi.RSSI()) + " dBm");
  } else {
    Serial.println("\n❌ WiFi Connection Failed!");
  }
}

// PERBAIKAN: Baca data dari PZEM dengan error handling
bool readPZEMData(float &voltage, float &current, float &power, float &energy, float &frequency, float &pf) {
  Serial.println("🔍 Reading PZEM sensors...");
  
  bool readSuccess = true;
  
  // Baca semua parameter dengan timeout
  voltage = pzem.voltage();
  delay(50);
  current = pzem.current();
  delay(50);
  power = pzem.power();
  delay(50);
  energy = pzem.energy();
  delay(50);
  frequency = pzem.frequency();
  delay(50);
  pf = pzem.pf();
  delay(50);
  
  // Validasi hasil pembacaan
  if (!isValid(voltage)) {
    Serial.println("❌ Invalid voltage reading!");
    voltage = 0.0;
    readSuccess = false;
  }
  if (!isValid(current)) {
    Serial.println("❌ Invalid current reading!");
    current = 0.0;
    readSuccess = false;
  }
  if (!isValid(power)) {
    Serial.println("❌ Invalid power reading!");
    power = 0.0;
    readSuccess = false;
  }
  if (!isValid(energy)) {
    Serial.println("❌ Invalid energy reading!");
    energy = 0.0;
    readSuccess = false;
  }
  if (!isValid(frequency)) {
    Serial.println("❌ Invalid frequency reading!");
    frequency = 0.0;
    readSuccess = false;
  }
  if (!isValid(pf)) {
    Serial.println("❌ Invalid power factor reading!");
    pf = 0.0;
    readSuccess = false;
  }
  
  return readSuccess;
}

// PERBAIKAN: Main function - selalu kirim data walaupun sensor error
void readAndSendData() {
  float voltage, current, power, energy, frequency, pf;
  
  // Baca data dari PZEM
  bool pzemDataValid = readPZEMData(voltage, current, power, energy, frequency, pf);
  
  // Tampilkan status pembacaan
  if (pzemDataValid) {
    Serial.println("📊 PZEM Readings (VALID):");
    failedReadings = 0; // Reset counter
  } else {
    Serial.println("📊 PZEM Readings (INVALID - Sending zero values):");
    failedReadings++;
    
    // Jika terlalu banyak failed readings, coba reconnect
    if (failedReadings >= MAX_FAILED_READINGS) {
      Serial.println("🔄 Too many failed readings, testing PZEM connection...");
      testPZEMConnection();
      failedReadings = 0;
    }
  }
  
  // Tampilkan data yang akan dikirim (selalu tampilkan walaupun invalid)
  Serial.println("  ⚡ Voltage: " + String(voltage, 1) + " V");
  Serial.println("  🔌 Current: " + String(current, 3) + " A");
  Serial.println("  💡 Power: " + String(power, 1) + " W");
  Serial.println("  🔋 Energy: " + String(energy, 3) + " kWh");
  Serial.println("  📈 Frequency: " + String(frequency, 1) + " Hz");
  Serial.println("  🎯 Power Factor: " + String(pf, 2));
  Serial.println("  📡 Device Status: " + String(pzemDataValid ? "SENSOR_OK" : "SENSOR_ERROR"));
  
  // PERBAIKAN: Selalu kirim data ke server, bahkan dengan nilai 0
  sendToServer(voltage, current, power, energy, frequency, pf, pzemDataValid);
  
  Serial.println("----------------------------------------");
}

// PERBAIKAN: Function to send data to server - selalu kirim data
void sendToServer(float v, float i, float p, float e, float f, float pf, bool sensorValid) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ WiFi not connected!");
    return;
  }
  
  HTTPClient http;
  
  // PERBAIKAN: Build URL dengan benar
  String serverURL = String(SERVER_BASE_URL) + "/api/data/power";
  
  Serial.println("🌐 Connecting to: " + serverURL);
  
  // Gunakan begin dengan WiFiClient
  WiFiClient client;
  if (!http.begin(client, serverURL)) {
    Serial.println("❌ Failed to begin HTTP connection");
    return;
  }
  
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(10000);
  http.setReuse(true);
  
  // PERBAIKAN: Buat JSON data dengan status sensor
  DynamicJsonDocument doc(512);
  doc["deviceId"] = deviceID;
  doc["voltage"] = round(v * 10) / 10.0;  // 1 decimal
  doc["current"] = round(i * 1000) / 1000.0; // 3 decimal
  doc["power"] = round(p * 10) / 10.0;    // 1 decimal
  doc["energy"] = round(e * 1000) / 1000.0; // 3 decimal
  doc["frequency"] = round(f * 10) / 10.0; // 1 decimal
  doc["power_factor"] = round(pf * 100) / 100.0; // 2 decimal
  doc["sensor_status"] = sensorValid ? "connected" : "disconnected";
  doc["failed_readings"] = failedReadings;
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["timestamp"] = millis();
  
  String jsonData;
  serializeJson(doc, jsonData);
  
  Serial.println("📤 Sending JSON: " + jsonData);
  
  // Kirim POST request
  int httpCode = http.POST(jsonData);
  
  // Handle response
  if (httpCode > 0) {
    Serial.println("✅ HTTP Response Code: " + String(httpCode));
    
    if (httpCode == 200) {
      String response = http.getString();
      Serial.println("📨 Server Response: " + response);
    } else {
      String response = http.getString();
      Serial.println("⚠️  Server Response: " + response);
    }
  } else {
    Serial.println("❌ HTTP Error: " + String(httpCode));
    Serial.println("Error: " + http.errorToString(httpCode));
  }
  
  http.end();
}