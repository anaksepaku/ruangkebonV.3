#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const char* ssid = "Home";
const char* password = "bayardulu";
#define SERVER_BASE_URL "http://172.16.0.76:3000"

// ==================== PIN DEFINITIONS ====================
const int phSensorPin = 34;      // GPIO34 untuk sensor pH
const int phPowerPin = 32;       // GPIO32 untuk kontrol power pH sensor
const int tdsSensorPin = 35;     // GPIO35 untuk sensor TDS
const int tdsPowerPin = 33;      // GPIO33 untuk kontrol power TDS sensor
const int relayPin = 2;          // GPIO2 untuk relay pompa

// ==================== KALIBRASI BERDASARKAN PENGUKURAN ANDA ====================
// KALIBRASI 1 TITIK (pH 7.0 buffer): Voltage = 2.3983V pada pH 7.0
const float PH_NEUTRAL_VOLTAGE = 2.3983;   // Ganti dari 2.5 ke 2.3983
const float PH_VOLTAGE_PER_UNIT = 0.18;    // Asumsi masih benar (default)
const float PH_OFFSET = 0.0;               // Additional offset jika perlu

// Voltage divider untuk proteksi ESP32
const float VOLTAGE_DIVIDER_RATIO = 0.33;  // Untuk resistor 10k+20k
const float ADC_REF_VOLTAGE = 3.3;         // Tegangan referensi ESP32
const int ADC_RESOLUTION = 4095;           // 12-bit ADC

// ==================== VARIABEL SISTEM ====================
String deviceID;
bool pompaStatus = false;
bool oledInitialized = false;
float pHValue = 7.0;
float tdsValue = 0.0;
float waterTemperature = 25.0;  // Default suhu air

// Interval waktu
unsigned long lastSendTime = 0;
const unsigned long sendInterval = 3000;
unsigned long lastSensorRead = 0;
const unsigned long sensorReadInterval = 2000;
unsigned long lastOLEDUpdate = 0;
const unsigned long OLEDUpdateInterval = 1000;

// Mode pengiriman
enum SendMode { SEND_PUMP, SEND_PH, SEND_TDS };
SendMode currentSendMode = SEND_PUMP;

// ==================== OLED ====================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define I2C_ADDRESS 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ==================== DEKLARASI FUNGSI ====================
void updateOLEDStatus();
void connectToWiFi();
void sendDataToServer();
String getTimeStamp();
String getDate();
float readPH();
float readTDS();
void readSensors();

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  Serial.println("\n\n🚀 HYDROPONIC SYSTEM v2.0 (CALIBRATED)");
  Serial.println("======================================");
  
  // Setup GPIO
  pinMode(relayPin, OUTPUT);
  pinMode(phPowerPin, OUTPUT);
  pinMode(tdsPowerPin, OUTPUT);
  
  digitalWrite(relayPin, LOW);
  digitalWrite(phPowerPin, LOW);
  digitalWrite(tdsPowerPin, LOW);
  pompaStatus = false;
  
  // Device ID
  deviceID = "HYDRO_" + String(ESP.getEfuseMac(), HEX);
  Serial.print("📟 Device ID: ");
  Serial.println(deviceID);
  
  // Konfigurasi ADC
  analogReadResolution(12);
  
  // OLED
  Serial.println("📺 Initializing OLED...");
  oledInitialized = display.begin(SSD1306_SWITCHCAPVCC, I2C_ADDRESS);
  
  if(oledInitialized) {
    Serial.println("✅ OLED initialized");
    display.clearDisplay();
    display.setTextSize(2);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(15, 10);
    display.println("pH METER");
    display.setTextSize(1);
    display.setCursor(25, 35);
    display.println("CALIBRATED");
    display.setCursor(30, 50);
    display.println("v2.0");
    display.display();
    delay(2000);
  }
  
  // WiFi
  connectToWiFi();
  
  // Info kalibrasi
  Serial.println("\n📊 CALIBRATION INFO:");
  Serial.print("   pH 7.0 voltage: ");
  Serial.print(PH_NEUTRAL_VOLTAGE, 4);
  Serial.println("V");
  Serial.print("   Voltage/unit: ");
  Serial.print(PH_VOLTAGE_PER_UNIT, 3);
  Serial.println("V per pH");
  Serial.print("   Divider ratio: ");
  Serial.println(VOLTAGE_DIVIDER_RATIO, 3);
  Serial.println("======================================\n");
}

// ==================== LOOP ====================
void loop() {
  // WiFi maintenance
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("🔄 Reconnecting WiFi...");
    connectToWiFi();
  }
  
  // Baca sensor
  if (millis() - lastSensorRead >= sensorReadInterval) {
    readSensors();
    lastSensorRead = millis();
  }
  
  // Kirim data
  if (millis() - lastSendTime >= sendInterval) {
    sendDataToServer();
    lastSendTime = millis();
  }
  
  // Update OLED
  if (millis() - lastOLEDUpdate >= OLEDUpdateInterval) {
    if (oledInitialized) {
      updateOLEDStatus();
    }
    lastOLEDUpdate = millis();
  }
  
  delay(100);
}

// ==================== FUNGSI BACA SENSOR ====================
void readSensors() {
  pHValue = readPH();
  tdsValue = readTDS();
  
  Serial.print("📊 Sensors - ");
  Serial.print("pH: ");
  Serial.print(pHValue, 2);
  Serial.print(" | TDS: ");
  Serial.print(tdsValue, 0);
  Serial.print(" ppm");
  Serial.print(" | Temp: ");
  Serial.print(waterTemperature, 1);
  Serial.println("°C");
}

// ==================== FUNGSI BACA pH YANG SUDAH DIKALIBRASI ====================
float readPH() {
  digitalWrite(phPowerPin, HIGH);
  delay(150);  // Tunggu sensor stabil
  
  // Baca dengan filter untuk mengurangi noise
  int samples = 15;
  long sum = 0;
  int validSamples = 0;
  int lastValue = 0;
  
  for(int i = 0; i < samples; i++) {
    int rawValue = analogRead(phSensorPin);
    
    // Filter outlier
    if(i == 0 || abs(rawValue - lastValue) < 50) {
      sum += rawValue;
      validSamples++;
      lastValue = rawValue;
    }
    
    delay(10);
  }
  
  digitalWrite(phPowerPin, LOW);
  
  if(validSamples == 0) {
    Serial.println("⚠️ pH Error: No valid samples");
    return 7.0;
  }
  
  float avgRaw = sum / (float)validSamples;
  
  // Konversi ke voltage dengan kompensasi voltage divider
  float voltageAtESP32 = avgRaw * (ADC_REF_VOLTAGE / ADC_RESOLUTION);
  float actualSensorVoltage = voltageAtESP32 / VOLTAGE_DIVIDER_RATIO;
  
  // Debug info (tampilkan hanya kadang-kadang)
  static int debugCounter = 0;
  if(debugCounter++ % 10 == 0) {
    Serial.print("🔍 pH Debug: RAW=");
    Serial.print(avgRaw, 0);
    Serial.print(" V_ESP=");
    Serial.print(voltageAtESP32, 3);
    Serial.print("V V_SENS=");
    Serial.print(actualSensorVoltage, 3);
    Serial.print("V");
  }
  
  // Validasi voltage range
  if(actualSensorVoltage < 1.0 || actualSensorVoltage > 3.5) {
    if(debugCounter % 10 == 0) {
      Serial.println(" ❌ INVALID VOLTAGE!");
    }
    return 7.0;  // Return safe value
  }
  
  // KONVERSI KE pH DENGAN KALIBRASI 1 TITIK
  // Formula: pH = 7.0 - ((voltage - PH_NEUTRAL_VOLTAGE) / PH_VOLTAGE_PER_UNIT)
  float pH = 7.0 - ((actualSensorVoltage - PH_NEUTRAL_VOLTAGE) / PH_VOLTAGE_PER_UNIT);
  
  // Tambahkan offset jika ada
  pH += PH_OFFSET;
  
  // Batasi range pH 0-14
  pH = constrain(pH, 0.0, 14.0);
  
  if(debugCounter % 10 == 0) {
    Serial.print(" pH=");
    Serial.println(pH, 2);
  }
  
  return pH;
}

// ==================== FUNGSI BACA TDS ====================
float readTDS() {
  digitalWrite(tdsPowerPin, HIGH);
  delay(100);
  
  long sum = 0;
  int samples = 20;
  
  for(int i = 0; i < samples; i++) {
    sum += analogRead(tdsSensorPin);
    delay(5);
  }
  
  digitalWrite(tdsPowerPin, LOW);
  
  float avgRaw = sum / (float)samples;
  float voltage = avgRaw * (ADC_REF_VOLTAGE / ADC_RESOLUTION);
  
  // Konversi ke TDS (simplified)
  float tds = 0.0;
  if(voltage > 0) {
    // Formula sederhana untuk TDS
    tds = voltage * 1000.0 * 0.5;  // Adjust factor sesuai kalibrasi
    tds = constrain(tds, 0.0, 2000.0);
  }
  
  return tds;
}

// ==================== FUNGSI KIRIM DATA KE SERVER ====================
void sendDataToServer() {
  switch(currentSendMode) {
    case SEND_PUMP:
      sendPompaStatus();
      currentSendMode = SEND_PH;
      break;
      
    case SEND_PH:
      sendPHSensorData();
      currentSendMode = SEND_TDS;
      break;
      
    case SEND_TDS:
      sendTDSSensorData();
      currentSendMode = SEND_PUMP;
      break;
  }
}

void sendPHSensorData() {
  // Validasi pH sebelum dikirim
  if(pHValue > 9.5 || pHValue < 4.5) {
    Serial.print("⚠️ Suspicious pH value: ");
    Serial.print(pHValue, 2);
    Serial.println(" - Sending safe value 7.0");
    pHValue = 7.0;
  }
  
  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/data/ph";
  
  String jsonData = "{"
                   "\"deviceId\":\"" + deviceID + "\","
                   "\"ph_value\":" + String(pHValue, 2) + ","
                   "\"wifi_rssi\":" + String(WiFi.RSSI()) + ","
                   "\"timestamp\":\"" + getTimeStamp() + "\","
                   "\"date\":\"" + getDate() + "\""
                   "}";
  
  Serial.println("📤 Sending pH Data: " + String(pHValue, 2));
  
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    int httpCode = http.POST(jsonData);
    
    if (httpCode > 0) {
      Serial.print("   ✅ HTTP Response: ");
      Serial.println(httpCode);
    } else {
      Serial.print("   ❌ HTTP Error: ");
      Serial.println(http.errorToString(httpCode));
    }
    
    http.end();
  }
}

void sendTDSSensorData() {
  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/data/tds";
  
  String jsonData = "{"
                   "\"deviceId\":\"" + deviceID + "\","
                   "\"tds_value\":" + String(tdsValue, 0) + ","
                   "\"tds\":" + String(tdsValue, 0) + ","
                   "\"temperature\":" + String(waterTemperature, 1) + ","
                   "\"suhu_air\":" + String(waterTemperature, 1) + ","
                   "\"wifi_rssi\":" + String(WiFi.RSSI()) + ","
                   "\"sensorType\":\"tds\","
                   "\"timestamp\":\"" + getTimeStamp() + "\","
                   "\"date\":\"" + getDate() + "\""
                   "}";
  
  Serial.println("📤 Sending TDS Data: " + String(tdsValue, 0) + " ppm");
  
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    int httpCode = http.POST(jsonData);
    
    if (httpCode > 0) {
      Serial.print("   ✅ HTTP Response: ");
      Serial.println(httpCode);
    }
    
    http.end();
  }
}

void sendPompaStatus() {
  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/data/pompa";
  
  String jsonData = "{" 
                   "\"deviceId\":\"" + deviceID + "\"," 
                   "\"status\":" + String(pompaStatus ? "true" : "false") + "," 
                   "\"mode\":\"manual\"," 
                   "\"wifi_rssi\":" + String(WiFi.RSSI()) + "," 
                   "\"heartbeat\":true," 
                   "\"controlled_by\":\"esp32\"," 
                   "\"timestamp\":\"" + getTimeStamp() + "\"," 
                   "\"date\":\"" + getDate() + "\"" 
                   "}";
  
  Serial.println("📤 Sending Pompa Status: " + String(pompaStatus ? "ON" : "OFF"));
  
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    int httpCode = http.POST(jsonData);
    
    if (httpCode > 0) {
      Serial.print("   ✅ HTTP Response: ");
      Serial.println(httpCode);
    }
    
    http.end();
  }
}

// ==================== FUNGSI OLED ====================
void updateOLEDStatus() {
  if (!oledInitialized) return;
  
  display.clearDisplay();
  
  // Header
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print("pH:");
  display.setCursor(25, 0);
  display.print(pHValue, 1);
  
  display.setCursor(70, 0);
  display.print("TDS:");
  display.setCursor(100, 0);
  display.print(tdsValue, 0);
  
  // Garis pemisah
  display.drawLine(0, 10, 128, 10, SSD1306_WHITE);
  
  // Status WiFi
  display.setCursor(0, 15);
  display.print("WiFi:");
  display.setCursor(35, 15);
  display.print(WiFi.RSSI());
  display.print("dBm");
  
  // Device ID (short)
  display.setCursor(0, 25);
  display.print("ID:");
  display.setCursor(20, 25);
  display.print(deviceID.substring(7, 15));
  
  // Next transmission
  display.setCursor(0, 35);
  display.print("Next:");
  switch(currentSendMode) {
    case SEND_PUMP: display.print("Pump"); break;
    case SEND_PH: display.print("pH"); break;
    case SEND_TDS: display.print("TDS"); break;
  }
  
  // Timestamp
  display.setCursor(0, 45);
  display.print(getTimeStamp());
  
  // Footer - calibration info
  display.setCursor(0, 55);
  display.print("Cal:v2.0");
  
  display.display();
}

// ==================== FUNGSI WiFi ====================
void connectToWiFi() {
  Serial.println("\n📡 CONNECTING TO WiFi...");
  Serial.print("   SSID: ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi CONNECTED!");
    Serial.print("   IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi FAILED!");
  }
}

// ==================== FUNGSI BANTU ====================
String getTimeStamp() {
  unsigned long seconds = millis() / 1000;
  unsigned long minutes = seconds / 60;
  unsigned long hours = minutes / 60;
  
  seconds %= 60;
  minutes %= 60;
  hours %= 24;
  
  char timestamp[9];
  sprintf(timestamp, "%02lu:%02lu:%02lu", hours, minutes, seconds);
  return String(timestamp);
}

String getDate() {
  return "05/12/2024";
}

// ==================== FUNGSI DEBUG & KALIBRASI ====================
void debugSensorReadings() {
  Serial.println("\n🔍 DEBUG SENSOR READINGS");
  Serial.println("========================");
  
  // Test pH sensor
  Serial.println("pH SENSOR TEST:");
  digitalWrite(phPowerPin, HIGH);
  delay(1000);
  
  for(int i = 0; i < 5; i++) {
    int raw = analogRead(phSensorPin);
    float vEsp32 = raw * (ADC_REF_VOLTAGE / ADC_RESOLUTION);
    float vSensor = vEsp32 / VOLTAGE_DIVIDER_RATIO;
    float pH = 7.0 - ((vSensor - PH_NEUTRAL_VOLTAGE) / PH_VOLTAGE_PER_UNIT);
    
    Serial.print("  ");
    Serial.print(i+1);
    Serial.print(": RAW=");
    Serial.print(raw);
    Serial.print(" V=");
    Serial.print(vSensor, 3);
    Serial.print("V pH=");
    Serial.println(pH, 2);
    
    delay(500);
  }
  
  digitalWrite(phPowerPin, LOW);
  Serial.println("========================");
}