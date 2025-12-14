testing menggunakan ARMBIAN 5.88 user-built Ubuntu 18.04.6 LTS 5.1.0-aml-s905 ( work ) 

jalankan dengan NODE.JS versi 11 ke atas.

install NPM

di Esp32 sesuikan SSID dan PASSWORD WIFI

Available Endpoints server

POST /api/data/power    - Receive power data");

POST /api/data/suhu     - Receive temperature data");

POST /api/data/ph       - Receive pH data");

POST /api/data/tds      - Receive TDS data");

POST /api/data/pompa    - Receive pump status");

GET  /api/status/all    - All sensors status");

GET  /api/device/info   - Device information"); 

GET  /api/health        - Server health check");
