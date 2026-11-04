# service_1.py  --  VERSI DIOPTIMALKAN + THINGSBOARD
#
# Dasar: rekonstruksi service_1.pyc (lihat service_1_asli.py untuk versi yang setia ke aslinya).
#
# VERSI WEBSITE: selain mengunggah ke ThingsBoard, program ini sekarang MENERIMA pengaturan dan
# perintah dari website (Fastify/Vue) lewat ThingsBoard: shared attributes dan RPC.
# Dengan ini main.py (dashboard lokal) tidak diperlukan lagi.
# Kendali lokal (sensor -> Redis -> relay lewat broker lokal) tetap sama; yang berubah adalah
# ketahanannya dan unggahan ke ThingsBoard. Perubahan perilaku ditandai "PERBAIKAN".
# PERBAIKAN (revisi 3): broker ESP bisa diatur lewat MQTT_* atau LOCAL_MQTT_* di .env, termasuk TLS (port 8883).
# PERBAIKAN (revisi 2, lihat raspi/CATATAN-PERBAIKAN.md): CLIENT_ID wajib diisi, is_active tidak lagi
# memblokir data bila kuncinya tidak ada, dosis EC berhenti bila mode diganti ke manual di tengah
# jalan, dan keadaan internal (pompa/kipas/pemanas) disamakan dengan relay saat sensor terputus.
import collections
import itertools
import json
import math
import os
import queue
import signal
import sys
import threading
import time
from datetime import datetime

import redis
from dotenv import load_dotenv
from paho.mqtt import client as mqtt_client

load_dotenv()
client_id = os.getenv('CLIENT_ID')
if not client_id:
    # PERBAIKAN: tanpa CLIENT_ID topik menjadi 'None/device-001' dan kunci Redis salah, tanpa pesan galat
    sys.exit('CLIENT_ID belum diisi di .env (contoh: CLIENT_ID=smartfarm-001)')
controller_number = 1
device_number = f'00{controller_number}'
device = f'device-{device_number}'
debug = os.getenv('DEBUG', '0').strip().lower() in ('1', 'true', 'yes')


def dprint(*args):
    """Log rinci, hanya bila DEBUG=1. Mengurangi tulisan log ke SD card."""
    if debug:
        print(*args)


r = redis.Redis()
topic = f'{client_id}/{device}'
topic_value = f'content_{client_id}/{device}'
device_topic = f'smartfarm/{device}'
check_status = 10          # detik tanpa data sensor sebelum dianggap mati

# ---------------------------------------------------------------------------
# Keadaan global (dipakai bersama oleh semua thread)
# ---------------------------------------------------------------------------
sensor_status = True       # True = sensor aktif mengirim data
last_active = datetime.now()
stop_threads = False
auto_mode = True           # True = kendali otomatis; False = manual (aktuator hanya digerakkan dari website)

pump_1 = True
pump_2 = False
pump_ec_a = False
pump_ec_b = False
pump_ph_up = False
pump_ph_down = False
pH_up = 7.6
pH_down = 5.6
fan = False
heater = False
high_temp = 30
delayFan = 30

NAN = float('nan')
temperature = 25
ec_value = NAN             # NaN = "belum ada data / tidak valid": semua perbandingan False -> tidak ada aksi
ph_value = NAN
air_temperature = NAN
humidity = NAN
flow = NAN

# Sisa kalibrasi dari kode asli (tidak dipakai)
_acidVoltage = 3058.0
_neutralVoltage = 2628.0
_kvalue = 1.0
_kvalueLow = 1.0
_kvalueHigh = 1.0
_ecCalibrationValue = 193
delayEc = 15
delayPh = 15
dap = datetime(2023, 2, 1, 7, 30, 0)
sensor = ''
count = 0
start_counter = 1
up_new = False


def _to_float(value):
    """PERBAIKAN: nilai sensor bisa berupa teks 'NaN'. Di kode asli itu membuat TypeError
    yang mematikan thread kipas/pH/balance secara permanen. Sekarang menjadi float NaN."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return NAN


# ---------------------------------------------------------------------------
# Redis: baca-ubah-tulis diserialisasi dengan lock
# PERBAIKAN: tujuh thread menulis content_<topic> secara bersamaan; tanpa lock,
# satu thread bisa menimpa perubahan thread lain dengan salinan yang sudah usang.
# ---------------------------------------------------------------------------
_state_lock = threading.RLock()


def update_state(mutate):
    with _state_lock:
        data = json.loads(r.get(topic_value).decode())
        mutate(data)
        r.set(topic_value, json.dumps(data))
        return data


def set_status(**fields):
    return update_state(lambda d: d['status'].update(fields))


def _reset_state(d):
    """Semua nilai sensor nol, semua relay mati kecuali pompa utama A."""
    d['value'].update(ec=0.0, ph=0.0, temp_water=0.0, temp_air=0.0, humidity=0.0, waterflow=0.0)
    d['status'].update(pump_ec_a=False, pump_ec_b=False, pump_ph_up=False, pump_ph_down=False,
                       pump_a=True, pump_b=False, fan=False, heater=False)


def _default_state():
    return {
        'controller': {'name': topic, 'number': controller_number},
        'config': {
            'ec_mode': 'all',
            'ec': 2.5,
            'ph_down': 5.6,
            'ph_up': 7.5,
            'fan_air_temp_min': 30.0,    # CATATAN: nilai bawaan asli; pemanas menyala bila suhu <= 30
            'fan_air_temp_max': 100.0,
            'fan_humidity': 30,
            'peristaltic_pump_duration': 60,
            'peristaltic_pump_period': 1,
            'waterflow': 0.0,
            'dap': [],
            'start_dap': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'is_active': True,
            'mode': 'auto',
        },
        'value': {'ec': 0.0, 'ph': 0.0, 'waterflow': 0.0, 'temp_air': 0.0, 'temp_water': 0.0, 'humidity': 0.0},
        'status': {
            'pump_ec_a': False, 'pump_ec_b': False, 'pump_ph_up': False, 'pump_ph_down': False,
            'pump_a': False, 'pump_b': False, 'fan': False, 'heater': False,
            'last_active': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        },
    }


def _init_state():
    """Salin keadaan tersimpan ke content_<topic>; buat nilai bawaan bila belum ada."""
    global last_active
    try:
        get_values = r.get(topic).decode()
        dprint(f"get from redis '{get_values}'")
        data = json.loads(get_values)
        last_active = datetime.strptime(data['status']['last_active'], '%Y-%m-%d %H:%M:%S')
        # PERBAIKAN: kode asli memanggil r.set(topic_value, data) dengan dict. Di redis-py baru itu
        # melempar DataError sehingga konfigurasi petani ter-reset ke bawaan setiap restart; di
        # redis-py lama isinya rusak (repr Python, bukan JSON). Sekarang disimpan sebagai JSON.
        r.set(topic_value, json.dumps(data))
    except Exception:
        default_value = json.dumps(_default_state())
        r.set(topic, default_value)
        r.set(topic_value, default_value)


_init_state()


def _load_mode():
    """Mode tersimpan di Redis, jadi bertahan saat restart. Nilai tak dikenal -> otomatis."""
    try:
        mode = json.loads(r.get(topic).decode())['config'].get('mode', 'auto')
    except Exception:
        mode = 'auto'
    return mode != 'manual'


auto_mode = _load_mode()

# ---------------------------------------------------------------------------
# Broker MQTT lokal (ESP sensor & relay)
# ---------------------------------------------------------------------------
def _env(*names, default=None):
    """Ambil nilai env pertama yang terisi dari daftar nama."""
    for name in names:
        value = os.getenv(name)
        if value not in (None, ''):
            return value
    return default


# PERBAIKAN (revisi 3): nama MQTT_* (dipakai .env sistem lama) kini ikut dibaca. Di kode asli variabel itu
# diabaikan dan broker selalu 'localhost'. Tanpa isian apa pun, perilaku tetap sama dengan kode asli.
#   LOCAL_MQTT_* atau MQTT_*: BROKER, PORT, USERNAME, PASSWORD, TLS, TLS_INSECURE
broker = _env('LOCAL_MQTT_BROKER', 'MQTT_BROKER', default='localhost')
port = int(_env('LOCAL_MQTT_PORT', 'MQTT_PORT', default='1883'))
username = _env('LOCAL_MQTT_USERNAME', 'MQTT_USERNAME', default='smartfarm')
# CATATAN: nilai bawaan sama dengan kode asli agar tetap jalan; sebaiknya isi password di .env
password = _env('LOCAL_MQTT_PASSWORD', 'MQTT_PASSWORD', default='smartfarm*2023')
# Port 8883 = TLS. TLS_INSECURE=true hanya untuk uji bila sertifikat server tidak dikenali (tidak aman)
mqtt_tls = _env('LOCAL_MQTT_TLS', 'MQTT_TLS', default='true' if port == 8883 else 'false').strip().lower() in ('1', 'true', 'yes')
mqtt_tls_insecure = _env('LOCAL_MQTT_TLS_INSECURE', 'MQTT_TLS_INSECURE', default='false').strip().lower() in ('1', 'true', 'yes')
print(f'Broker MQTT untuk ESP: {broker}:{port} (TLS={mqtt_tls}, user={username})')
deviceId = client_id
esp_dc = deviceId + '-dc'
esp_ac = deviceId + '-ac'


def _new_client():
    """PERBAIKAN: paho-mqtt 2.x menolak Client() tanpa callback_api_version. Callback di bawah
    memakai tanda tangan versi 1, jadi VERSION1 dipilih bila tersedia (paho 1.x tetap jalan)."""
    version = getattr(mqtt_client, 'CallbackAPIVersion', None)
    if version is not None:
        return mqtt_client.Client(version.VERSION1)
    return mqtt_client.Client()


def publish(client, status, to, type, timer=0):
    msg = json.dumps({'action': status, 'from': deviceId, 'to': to, 'type': type, 'timer': timer})
    result = client.publish(device_topic, msg)
    if result.rc == 0:
        print(f"Send `{msg}` to topic `{device_topic}`")
        time.sleep(2)
        return True
    print(f"Failed to send message to topic {device_topic}")
    return False


def on_message(client, userdata, msg):
    global sensor_status, last_active
    global ec_value, ph_value, temperature, air_temperature, humidity, flow
    try:
        y = json.loads(str(msg.payload.decode('utf-8')))
        _from = y['from']
        to = y['to']
        _type = y['type']

        if _from == f'{client_id}-{device_number}-sensor':
            sensor_status = True
            last_active = datetime.now()
            with _state_lock:
                data = json.loads(r.get(topic_value).decode())
                if not data['config'].get('is_active', True):    # PERBAIKAN: KeyError bila kunci tidak ada
                    return
                data['status']['last_active'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                # Nilai mentah disimpan apa adanya (main.py mengenali teks 'NaN' di dashboard)
                data['value'].update(ec=y['ec'], ph=y['ph'], temp_water=y['temp_water'],
                                     temp_air=y['temp_air'], humidity=y['humidity'], waterflow=y['waterflow'])
                data['status']['pump_a'] = pump_1
                data['status']['pump_b'] = pump_2
                # Untuk kendali, nilai tidak valid menjadi NaN (tidak memicu aksi apa pun)
                ec_value = _to_float(y['ec'])
                ph_value = _to_float(y['ph'])
                temperature = _to_float(y['temp_water'])
                air_temperature = _to_float(y['temp_air'])
                humidity = _to_float(y['humidity'])
                flow = _to_float(y['waterflow'])
                r.set(topic_value, json.dumps(data))
            dprint(f"new data '{json.dumps(data)}'")

        elif to == deviceId:
            action = y['action']
            print(f'aksi: {action} type: {_type} dari: {to}')

        elif _from == deviceId:
            print(f'laporan diterima {_from}')
    except Exception as error:
        print(f'An exception occurred: {error!r}')


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print('Successfully connected to MQTT broker')
        client.subscribe(topic, qos=1)
    else:
        print(f'Failed to connect, return code {rc}')


client = _new_client()
client.username_pw_set(username, password)
if mqtt_tls:
    import ssl
    if mqtt_tls_insecure:
        client.tls_set(cert_reqs=ssl.CERT_NONE)
        client.tls_insecure_set(True)
    else:
        client.tls_set()
client.on_connect = on_connect
client.on_message = on_message


def _connect_local():
    """PERBAIKAN: bila mosquitto belum siap saat layanan start, kode asli langsung crash.
    Sekarang mencoba lagi tiap 5 detik."""
    while True:
        try:
            client.connect(broker, port, 60)
            return
        except Exception as error:
            print(f'Broker lokal {broker}:{port} belum siap ({error}); coba lagi 5 detik')
            time.sleep(5)


_connect_local()

# ---------------------------------------------------------------------------
# ThingsBoard (MQTT online): telemetri + atribut
# Login memakai access token device sebagai username (password kosong).
# Pengaturan dari .env:
#   THINGSBOARD_TOKEN     access token device (wajib; kosong = unggahan dinonaktifkan)
#   THINGSBOARD_HOST      default mqtt.thingsboard.cloud
#   THINGSBOARD_TLS       true/false, default false (true -> port 8883)
#   THINGSBOARD_PORT      default 1883, atau 8883 bila TLS
#   THINGSBOARD_INTERVAL  jeda pengambilan sampel (detik), default 10
#   THINGSBOARD_BUFFER    jumlah sampel maksimum yang ditahan saat offline, default 2000
# ---------------------------------------------------------------------------
tb_host = os.getenv('THINGSBOARD_HOST', 'mqtt.thingsboard.cloud')
tb_use_tls = os.getenv('THINGSBOARD_TLS', 'false').strip().lower() in ('1', 'true', 'yes')
tb_port = int(os.getenv('THINGSBOARD_PORT', '8883' if tb_use_tls else '1883'))
tb_token = os.getenv('THINGSBOARD_TOKEN')
tb_interval = max(1, int(os.getenv('THINGSBOARD_INTERVAL', '10')))
tb_buffer_max = max(1, int(os.getenv('THINGSBOARD_BUFFER', '2000')))
tb_batch_size = 50           # sampel per pesan MQTT
tb_max_batches = 20          # batas pesan per siklus agar tidak menahan thread terlalu lama
tb_ack_timeout = 5.0         # detik menunggu PUBACK dari ThingsBoard
tb_telemetry_topic = 'v1/devices/me/telemetry'
tb_attributes_topic = 'v1/devices/me/attributes'                    # kirim atribut klien + terima update shared
tb_attr_response_topic = 'v1/devices/me/attributes/response/+'
tb_attr_response_prefix = 'v1/devices/me/attributes/response/'
tb_attr_request_prefix = 'v1/devices/me/attributes/request/'
tb_rpc_request_topic = 'v1/devices/me/rpc/request/+'
tb_rpc_request_prefix = 'v1/devices/me/rpc/request/'
tb_rpc_response_prefix = 'v1/devices/me/rpc/response/'
tb_wakeup = threading.Event()   # dibangunkan saat ada perubahan agar status langsung diunggah
tb_connected = False
tb_last_config = None        # atribut terakhir yang DITERIMA ThingsBoard; None = kirim ulang
tb_buffer = collections.deque(maxlen=tb_buffer_max)   # sampel {'ts':ms,'values':{...}} menunggu terkirim

_TB_VALUE_KEYS = ('ec', 'ph', 'temp_water', 'temp_air', 'humidity', 'waterflow')
_TB_STATUS_KEYS = ('pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down',
                   'pump_a', 'pump_b', 'fan', 'heater')
_TB_CONFIG_KEYS = ('ec_mode', 'ec', 'ph_down', 'ph_up', 'fan_air_temp_min', 'fan_air_temp_max',
                   'fan_humidity', 'peristaltic_pump_duration', 'peristaltic_pump_period',
                   'waterflow', 'dap', 'start_dap', 'is_active')


def tb_on_connect(client, userdata, flags, rc):
    global tb_connected, tb_last_config
    if rc == 0:
        tb_connected = True
        tb_last_config = None      # setelah (re)connect, kirim ulang atribut
        print(f'ThingsBoard: terhubung ke {tb_host}:{tb_port}')
        # Berlangganan penerimaan dari website, LALU minta nilai shared attribute terbaru
        # (urutan ini disyaratkan ThingsBoard; permintaan ini juga menerapkan pengaturan saat boot).
        client.subscribe(tb_attributes_topic, qos=1)
        client.subscribe(tb_attr_response_topic, qos=1)
        client.subscribe(tb_rpc_request_topic, qos=1)
        client.publish(tb_attr_request_prefix + '1', json.dumps({'sharedKeys': ','.join(_REMOTE_KEYS)}), qos=1)
    else:
        tb_connected = False
        # rc 4 = username/token salah, rc 5 = tidak berwenang
        print(f'ThingsBoard: gagal terhubung, kode {rc} (cek THINGSBOARD_TOKEN)')


def tb_on_disconnect(client, userdata, rc):
    global tb_connected
    tb_connected = False
    if rc != 0:
        print('ThingsBoard: koneksi terputus, mencoba menyambung lagi')


def _enqueue(item):
    try:
        remote_queue.put_nowait(item)
    except queue.Full:
        print('Penerimaan dari website: antrean penuh, pesan dibuang')
        if item[0] == 'rpc':
            _respond(item[1], {'ok': False, 'error': 'perangkat sibuk, antrean penuh'})


def tb_on_message(client, userdata, msg):
    """Hanya mengurai dan memasukkan ke antrean. Pekerjaan berat (kirim relay, tidur 2 detik per
    perintah) dilakukan thread _remoteWorker agar thread jaringan MQTT tidak tertahan."""
    try:
        payload = json.loads(msg.payload.decode('utf-8'))
    except Exception:
        payload = None
    if msg.topic.startswith(tb_rpc_request_prefix):
        request_id = msg.topic[len(tb_rpc_request_prefix):]
        if isinstance(payload, dict):
            _enqueue(('rpc', request_id, payload))
        else:
            _enqueue(('rpc_error', request_id, 'payload RPC bukan objek JSON'))
    elif msg.topic == tb_attributes_topic or msg.topic.startswith(tb_attr_response_prefix):
        if isinstance(payload, dict):
            # update shared: {"ec": 2.7}; respons permintaan: {"shared": {...}}
            _enqueue(('attrs', payload['shared'] if isinstance(payload.get('shared'), dict) else payload))


tb_client = _new_client()
tb_client.on_connect = tb_on_connect
tb_client.on_disconnect = tb_on_disconnect
tb_client.on_message = tb_on_message


def tb_start():
    """Mulai koneksi ThingsBoard di thread latar belakang (tidak memblokir kendali lokal)."""
    if not tb_token:
        print('ThingsBoard: THINGSBOARD_TOKEN kosong, unggahan dinonaktifkan')
        return False
    tb_client.username_pw_set(tb_token)
    if tb_use_tls:
        tb_client.tls_set()
    tb_client.reconnect_delay_set(min_delay=1, max_delay=60)
    tb_client.connect_async(tb_host, tb_port, 60)
    tb_client.loop_start()
    return True


def _tb_number(v):
    """Hanya angka valid yang diunggah; 'NaN' (teks maupun float) dilewati."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def build_telemetry(data, online):
    """Susun nilai telemetri dari isi content_<topic>.
    Saat sensor offline, nilai sensor DIHILANGKAN (di Redis nilainya sudah dinolkan oleh pengawas,
    mengunggah nol akan tampak seperti pembacaan sungguhan di grafik)."""
    telemetry = {}
    if online:
        for key in _TB_VALUE_KEYS:
            if _tb_number(data['value'].get(key)):
                telemetry[key] = data['value'][key]
    for key in _TB_STATUS_KEYS:
        if key in data['status']:
            telemetry[key] = bool(data['status'][key])
    telemetry['sensor_online'] = bool(online)
    telemetry['mode'] = 'auto' if auto_mode else 'manual'
    return telemetry


def build_attributes(config, errors=None):
    """Atribut KLIEN = pengaturan yang benar-benar berlaku di perangkat (website membaca ini),
    terpisah dari atribut SHARED = yang diminta website. config_errors memuat alasan penolakan."""
    attrs = {key: config[key] for key in _TB_CONFIG_KEYS if key in config}
    attrs['mode'] = 'auto' if auto_mode else 'manual'
    attrs['config_errors'] = dict(errors or {})
    return attrs


def _tb_wait(info, timeout=None):
    """Tunggu PUBACK (QoS 1). Hanya memakai is_published() agar jalan di paho 1.x maupun 2.x."""
    deadline = time.monotonic() + (tb_ack_timeout if timeout is None else timeout)
    while True:
        if info.is_published():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def _tb_sample():
    data = json.loads(r.get(topic_value).decode())
    return {'ts': int(time.time() * 1000), 'values': build_telemetry(data, sensor_status)}


def _tb_flush():
    """Kirim sampel tertahan (terlama dulu) per kelompok. Sampel baru dibuang dari buffer
    setelah ThingsBoard membalas PUBACK, jadi tidak ada data hilang bila koneksi putus.
    Mengirim ulang sampel dengan ts yang sama aman: ThingsBoard menimpa, bukan menggandakan."""
    for _ in range(tb_max_batches):
        if not tb_buffer or not tb_connected:
            return True
        batch = list(itertools.islice(tb_buffer, tb_batch_size))
        info = tb_client.publish(tb_telemetry_topic, json.dumps(batch), qos=1)
        if info.rc != 0 or not _tb_wait(info):
            print(f'ThingsBoard: telemetri belum terkirim ({len(tb_buffer)} sampel menunggu)')
            return False
        for _ in batch:
            tb_buffer.popleft()
    return True


def _tb_send_attributes():
    global tb_last_config
    config = build_attributes(json.loads(r.get(topic).decode())['config'], tb_config_errors)
    if config == tb_last_config:
        return
    info = tb_client.publish(tb_attributes_topic, json.dumps(config), qos=1)
    if info.rc == 0 and _tb_wait(info):
        tb_last_config = config
    else:
        print('ThingsBoard: atribut belum terkirim, dicoba lagi siklus berikutnya')


def _uploadThingsboard():
    """Tiap tb_interval detik: ambil sampel, kirim semua yang tertahan, lalu atribut bila berubah."""
    while True:
        tb_wakeup.wait(tb_interval)
        tb_wakeup.clear()
        if stop_threads:
            break
        try:
            tb_buffer.append(_tb_sample())
            if not tb_connected:
                continue
            _tb_flush()
            _tb_send_attributes()
        except Exception as error:
            print('ThingsBoard')
            print(error)


# ---------------------------------------------------------------------------
# PENERIMAAN dari website (Fastify/Vue) lewat ThingsBoard
#
#  1) PENGATURAN  -> shared attributes (tersimpan di ThingsBoard, diminta ulang tiap perangkat menyala)
#     atau RPC "setConfig" (balasan langsung ok/ditolak). Dua-duanya divalidasi SAMA.
#  2) MODE        -> shared attribute "mode" ("auto"/"manual") atau RPC "setMode".
#  3) AKTUATOR    -> RPC "setActuator", hanya diterima saat mode manual.
#  4) STATUS      -> RPC "getState".
# Hasil yang berlaku dilaporkan balik sebagai atribut klien (+ config_errors bila ada yang ditolak).
# ---------------------------------------------------------------------------
MANUAL_MAX_DURATION = max(1, int(os.getenv('MANUAL_MAX_DURATION', '300')))   # detik, batas dosis manual
remote_queue = queue.Queue(maxsize=100)
tb_config_errors = {}          # {kunci: alasan} untuk pengaturan terakhir yang ditolak
_scheduled = []                # penyelesaian dosis manual: {'key', 'due', 'fn'}

# Batas nilai (kasar, hanya untuk menolak nilai yang jelas salah dari jarak jauh).
# CATATAN: 'ec' diasumsikan mS/cm (bawaan 2.5). Bila Anda memakai ppm/TDS, naikkan batasnya.
_REMOTE_SPEC = {
    'mode': ('enum', ('auto', 'manual')),
    'ec_mode': ('enum', ('all', 'single')),
    'ec': ('num', 0.0, 20.0),
    'ph_down': ('num', 0.0, 14.0),
    'ph_up': ('num', 0.0, 14.0),
    'fan_air_temp_min': ('num', -20.0, 100.0),
    'fan_air_temp_max': ('num', -20.0, 100.0),
    'fan_humidity': ('num', 0.0, 100.0),
    'peristaltic_pump_duration': ('num', 1.0, 600.0),
    'peristaltic_pump_period': ('num', 0.0, 1440.0),
    'waterflow': ('num', 0.0, 1000.0),
    'dap': ('list', 0.0, 20.0, 400),
    'start_dap': ('datetime',),
}
_REMOTE_KEYS = tuple(_REMOTE_SPEC)

_DOSING = {'pump_ec_a': 'relay1', 'pump_ec_b': 'relay2', 'pump_ph_up': 'relay3', 'pump_ph_down': 'relay4'}


def _validate_remote(key, value):
    """None bila valid, selain itu alasan penolakan."""
    spec = _REMOTE_SPEC[key]
    kind = spec[0]
    if kind == 'enum':
        return None if (isinstance(value, str) and value in spec[1]) else 'harus salah satu dari ' + ', '.join(spec[1])
    if kind == 'num':
        if _tb_number(value) and spec[1] <= value <= spec[2]:
            return None
        return f'harus angka {spec[1]:g} sampai {spec[2]:g}'
    if kind == 'list':
        if not isinstance(value, list) or len(value) > spec[3]:
            return f'harus daftar angka (maksimum {spec[3]} nilai)'
        if all(_tb_number(v) and spec[1] <= v <= spec[2] for v in value):
            return None
        return f'setiap nilai harus angka {spec[1]:g} sampai {spec[2]:g}'
    try:
        datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
        return None
    except (TypeError, ValueError):
        return 'format harus YYYY-MM-DD HH:MM:SS'


def _clean(obj):
    """JSON yang aman dikirim: float tak hingga/NaN menjadi None."""
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    return obj


def _read_state():
    return json.loads(r.get(topic_value).decode())


def apply_remote_config(updates):
    """Terapkan pengaturan dari website. Mengembalikan (diterapkan, ditolak).
    Kunci di luar _REMOTE_KEYS diabaikan (ThingsBoard bisa membawa atribut lain). Nilai yang ditolak
    tidak mengubah apa pun dan alasannya dilaporkan lewat atribut klien 'config_errors'."""
    global tb_config_errors
    if not isinstance(updates, dict):
        return {}, {}
    candidates = {k: updates[k] for k in _REMOTE_KEYS if k in updates}
    if not candidates:
        return {}, {}
    valid, rejected = {}, {}
    for key, value in candidates.items():
        reason = _validate_remote(key, value)
        if reason:
            rejected[key] = reason
        else:
            valid[key] = value
    with _state_lock:
        data = json.loads(r.get(topic).decode())
        config = data['config']
        merged = {**config, **valid}
        for low, high, text in (('ph_down', 'ph_up', 'ph_down harus lebih kecil dari ph_up'),
                                ('fan_air_temp_min', 'fan_air_temp_max', 'fan_air_temp_min harus lebih kecil dari fan_air_temp_max')):
            if (low in valid or high in valid) and not (
                    _tb_number(merged.get(low)) and _tb_number(merged.get(high)) and merged[low] < merged[high]):
                for key in (low, high):
                    if key in valid:
                        rejected[key] = text
                        del valid[key]
        previous_mode = 'auto' if auto_mode else 'manual'
        if valid:
            config.update(valid)
            r.set(topic, json.dumps(data))
        errors = {k: v for k, v in tb_config_errors.items() if k not in candidates}
        errors.update(rejected)
        tb_config_errors = errors
    if valid:
        print(f'Pengaturan dari website diterapkan: {valid}')
    if rejected:
        print(f'Pengaturan dari website DITOLAK: {rejected}')
    if 'mode' in valid and valid['mode'] != previous_mode:
        _switch_mode(valid['mode'])
    tb_wakeup.set()            # laporkan hasilnya segera
    return valid, rejected


def _switch_mode(new_mode):
    """auto -> manual: kendali otomatis berhenti dan semua aktuator (kecuali pompa utama) dimatikan
    agar tidak ada yang menyala tanpa pengawasan. manual -> auto: kendali otomatis lanjut (dan bila
    kedua pompa utama dimatikan saat manual, pompa A dinyalakan kembali)."""
    global auto_mode, pump_ec_a, pump_ec_b, pump_ph_up, pump_ph_down, fan, heater, pump_1
    print(f'Mode sistem: {new_mode}')
    if new_mode == 'auto':
        if not (pump_1 or pump_2):
            # pengguna mematikan kedua pompa utama saat manual; kendali otomatis (termasuk penukar
            # pompa) mengandaikan salah satunya menyala, jadi pompa A dinyalakan kembali
            if publish(client, 'on', esp_ac, 'relay5'):
                pump_1 = True
                set_status(pump_a=True, pump_b=False)
        auto_mode = True
        return
    auto_mode = False                      # dulu: hentikan aksi otomatis baru
    _scheduled.clear()
    pump_ec_a = pump_ec_b = pump_ph_up = pump_ph_down = False
    fan = heater = False
    set_status(pump_ec_a=False, pump_ec_b=False, pump_ph_up=False, pump_ph_down=False, fan=False, heater=False)
    for relay in _DOSING.values():
        publish(client, 'off', esp_dc, relay)
    publish(client, 'off', esp_ac, 'relay7', delayFan)
    publish(client, 'off', esp_ac, 'relay8', delayFan)


def _schedule(key, delay, fn):
    _scheduled[:] = [x for x in _scheduled if x['key'] != key]
    _scheduled.append({'key': key, 'due': time.monotonic() + delay, 'fn': fn})


def _run_scheduled(now=None):
    now = time.monotonic() if now is None else now
    for item in [x for x in _scheduled if x['due'] <= now]:
        _scheduled.remove(item)
        try:
            item['fn']()
        except Exception as error:
            print(f"Penyelesaian terjadwal gagal: {error!r}")


def _finish_dosing(name):
    globals()[name] = False
    set_status(**{name: False})
    tb_wakeup.set()


def _fail(message):
    return {'ok': False, 'error': message}


def _rpc_set_actuator(params):
    global fan, heater, pump_1, pump_2
    if auto_mode:
        return _fail('Mode otomatis aktif; ubah ke manual terlebih dahulu')
    name, state = params.get('actuator'), params.get('state')
    if name not in _DOSING and name not in ('fan', 'heater', 'pump_a', 'pump_b'):
        return _fail('actuator tidak dikenal; pilih: ' + ', '.join(list(_DOSING) + ['fan', 'heater', 'pump_a', 'pump_b']))
    if not isinstance(state, bool):
        return _fail('state harus true atau false')

    if name in _DOSING:                                    # pompa dosis (berwaktu, ESP mematikan sendiri)
        relay = _DOSING[name]
        if not state:
            _scheduled[:] = [x for x in _scheduled if x['key'] != name]
            globals()[name] = False
            set_status(**{name: False})
            if not publish(client, 'off', esp_dc, relay):
                return _fail('perintah gagal dikirim ke ESP (broker lokal)')
            tb_wakeup.set()
            return {'ok': True, 'actuator': name, 'state': False}
        busy = [n for n in _DOSING if n != name and _read_state()['status'].get(n)]
        if busy:
            return _fail('pompa dosis lain sedang aktif: ' + ', '.join(busy))
        duration = params.get('duration')
        if duration is None:
            duration = json.loads(r.get(topic).decode())['config']['peristaltic_pump_duration']
        if not _tb_number(duration) or not 1 <= duration <= MANUAL_MAX_DURATION:
            return _fail(f'duration harus angka 1 sampai {MANUAL_MAX_DURATION} detik')
        globals()[name] = True
        set_status(**{name: True})
        if not publish(client, 'on', esp_dc, relay, duration):
            globals()[name] = False
            set_status(**{name: False})
            return _fail('perintah gagal dikirim ke ESP (broker lokal)')
        _schedule(name, duration, lambda n=name: _finish_dosing(n))
        tb_wakeup.set()
        return {'ok': True, 'actuator': name, 'state': True, 'duration': duration}

    if name in ('fan', 'heater'):
        relay = 'relay7' if name == 'fan' else 'relay8'
        before = fan if name == 'fan' else heater
        if name == 'fan':
            fan = state
        else:
            heater = state
        set_status(**{name: state})
        if not publish(client, 'on' if state else 'off', esp_ac, relay, delayFan):
            if name == 'fan':
                fan = before
            else:
                heater = before
            set_status(**{name: before})
            return _fail('perintah gagal dikirim ke ESP (broker lokal)')
        tb_wakeup.set()
        return {'ok': True, 'actuator': name, 'state': state}

    # pompa utama A/B. Mode manual = kendali penuh di tangan pengguna, jadi boleh dimatikan (juga
    # kedua-duanya). Keduanya tidak boleh menyala bersamaan: menyalakan satu memindahkan dari yang lain.
    to_a = name == 'pump_a'
    is_on = pump_1 if to_a else pump_2
    if not state:
        if not is_on:
            return {'ok': True, 'actuator': name, 'state': False, 'unchanged': True}
        if not publish(client, 'off', esp_ac, 'relay5' if to_a else 'relay6'):
            return _fail('perintah gagal dikirim ke ESP (broker lokal)')
        if to_a:
            pump_1 = False
        else:
            pump_2 = False
        set_status(pump_a=pump_1, pump_b=pump_2)
        tb_wakeup.set()
        return {'ok': True, 'actuator': name, 'state': False}
    if is_on:
        return {'ok': True, 'actuator': name, 'state': True, 'unchanged': True}
    off_relay, on_relay = ('relay6', 'relay5') if to_a else ('relay5', 'relay6')
    if not (publish(client, 'off', esp_ac, off_relay) and publish(client, 'on', esp_ac, on_relay)):
        publish(client, 'on', esp_ac, 'relay6' if to_a else 'relay5')      # upaya memulihkan pompa semula
        return _fail('perintah gagal dikirim ke ESP (broker lokal); pompa dikembalikan ke semula')
    pump_1, pump_2 = to_a, not to_a
    set_status(pump_a=pump_1, pump_b=pump_2)
    tb_wakeup.set()
    return {'ok': True, 'actuator': name, 'state': True}


def _respond(request_id, result):
    try:
        tb_client.publish(tb_rpc_response_prefix + str(request_id), json.dumps(_clean(result)), qos=1)
    except Exception as error:
        print(f'RPC {request_id}: balasan gagal dikirim {error!r}')


def handle_rpc(request_id, payload):
    """Jalankan satu perintah RPC dan SELALU membalas {"ok": true/false, ...}."""
    try:
        method, params = payload.get('method'), payload.get('params')
        if isinstance(params, str):
            params = json.loads(params)
        if params is None:
            params = {}
        if not isinstance(params, dict):
            result = _fail('params harus objek JSON')
        elif method == 'setMode':
            valid, rejected = apply_remote_config({'mode': params.get('mode')})
            result = _fail(rejected['mode']) if rejected else {'ok': True, 'mode': 'auto' if auto_mode else 'manual'}
        elif method == 'setConfig':
            unknown = [k for k in params if k not in _REMOTE_KEYS]
            valid, rejected = apply_remote_config(params)
            ok = bool(valid) and not rejected
            result = {'ok': ok, 'applied': valid, 'rejected': rejected, 'unknown': unknown}
            if not valid and not rejected:
                result['error'] = 'tidak ada pengaturan yang dikenal'
        elif method == 'setActuator':
            result = _rpc_set_actuator(params)
        elif method == 'getState':
            data = _read_state()
            result = {'ok': True, 'mode': 'auto' if auto_mode else 'manual', 'sensor_online': sensor_status,
                      'status': data['status'], 'values': data['value'],
                      'config': build_attributes(json.loads(r.get(topic).decode())['config'], tb_config_errors)}
        else:
            result = _fail(f'method {method!r} tidak dikenal')
    except Exception as error:
        result = _fail(f'galat di perangkat: {error!r}')
    print(f"RPC {request_id} {payload.get('method')}: {'OK' if result.get('ok') else result.get('error') or result.get('rejected')}")
    _respond(request_id, result)


def handle_remote_item(item):
    if item[0] == 'attrs':
        apply_remote_config(item[1])
    elif item[0] == 'rpc':
        handle_rpc(item[1], item[2])
    elif item[0] == 'rpc_error':
        _respond(item[1], _fail(item[2]))


def _remoteWorker():
    """Satu thread memproses perintah dari website satu per satu, berurutan, dan menyelesaikan
    dosis manual yang sudah waktunya."""
    while not stop_threads:
        try:
            item = remote_queue.get(timeout=0.5)
        except queue.Empty:
            item = None
        _run_scheduled()
        if item is not None:
            try:
                handle_remote_item(item)
            except Exception as error:
                print(f'Penerimaan dari website: galat {error!r}')


# ---------------------------------------------------------------------------
# Thread kendali
# ---------------------------------------------------------------------------
def _relay_start():
    """Kondisi awal: semua relay mati kecuali relay5 (pompa A)."""
    data = update_state(_reset_state)
    dprint(f"new data '{json.dumps(data)}'")
    publish(client, 'off', esp_dc, 'relay1')
    publish(client, 'off', esp_dc, 'relay2')
    publish(client, 'off', esp_dc, 'relay3')
    publish(client, 'off', esp_dc, 'relay4')
    publish(client, 'off', esp_ac, 'relay6')
    publish(client, 'off', esp_ac, 'relay7')
    publish(client, 'off', esp_ac, 'relay8')
    publish(client, 'on', esp_ac, 'relay5')


def _pumpEC():
    """Dosis nutrisi EC: pompa A (relay1) lalu pompa B (relay2)."""
    global pump_ec_a, pump_ec_b
    e = threading.Event()
    interval = 1
    while True:
        e.wait(interval)
        if stop_threads:
            break
        if not auto_mode:
            continue
        try:
            data = json.loads(r.get(topic).decode())
            duration = data['config']['peristaltic_pump_duration']
            period = data['config']['peristaltic_pump_period'] * 60
            sf_config_ec = float(data['config']['ec'])

            if data['config']['ec_mode'] != 'all':
                # target EC mengikuti hari setelah tanam (DAP)
                daps = datetime.strptime(data['config']['start_dap'], '%Y-%m-%d %H:%M:%S')
                dap_selisih1 = datetime.now() - daps
                try:
                    if dap_selisih1.days < 0:        # PERBAIKAN: indeks negatif mengambil elemen terakhir
                        raise IndexError('start_dap di masa depan')
                    sf_config_ec = data['config']['dap'][dap_selisih1.days]
                except Exception as error:
                    print('DAP')
                    print(error)

            if (ec_value < sf_config_ec) and sensor_status:
                time.sleep(10)
                if ec_value < sf_config_ec and auto_mode:
                    pump_ec_a = True                                  # pompa EC A
                    set_status(pump_ec_a=True, pump_ec_b=False)
                    publish(client, 'on', esp_dc, 'relay1', duration)
                    time.sleep(duration)
                    pump_ec_a = False
                    set_status(pump_ec_a=False, pump_ec_b=False)

                    # PERBAIKAN: bila mode diganti ke manual saat pompa A bekerja, pompa B tidak boleh
                    # menyala sendiri (semua dosis sudah dimatikan oleh _switch_mode)
                    if auto_mode:
                        pump_ec_b = True                              # pompa EC B
                        set_status(pump_ec_a=False, pump_ec_b=True)
                        publish(client, 'on', esp_dc, 'relay2', duration)
                        time.sleep(duration)
                        pump_ec_b = False
                        set_status(pump_ec_a=False, pump_ec_b=False)
                time.sleep(period)
        except Exception as error:
            print('EC')
            print(error)


def _dose_ph(up):
    """Pompa pH. up=True: pH up (relay3, ambang config 'ph_down'); up=False: pH down (relay4, 'ph_up').
    CATATAN: nama kunci config tampak terbalik tetapi logikanya benar (pH di bawah batas bawah -> naikkan)."""
    global pH_down, pH_up, pump_ph_up, pump_ph_down
    e = threading.Event()
    interval = 1
    relay, status_key = ('relay3', 'pump_ph_up') if up else ('relay4', 'pump_ph_down')
    while True:
        e.wait(interval)
        if stop_threads:
            break
        if not auto_mode:
            continue
        data = json.loads(r.get(topic).decode())
        duration = data['config']['peristaltic_pump_duration']
        period = data['config']['peristaltic_pump_period']   # CATATAN: tanpa "* 60" (beda dengan _pumpEC)
        if up:
            pH_down = float(data['config']['ph_down'])
            out_of_range = lambda: ph_value < pH_down
        else:
            pH_up = float(data['config']['ph_up'])
            out_of_range = lambda: ph_value > pH_up
        if out_of_range() and sensor_status:
            val = 0
            for x in range(9):
                if out_of_range():
                    val = val + 1
                time.sleep(1)
            if val > 5 and auto_mode:
                publish(client, 'on', esp_dc, relay, duration)
                if up:
                    pump_ph_up = True
                else:
                    pump_ph_down = True
                set_status(**{status_key: True})
                time.sleep(duration)
                if up:
                    pump_ph_up = False
                else:
                    pump_ph_down = False
                set_status(**{status_key: False})
            time.sleep(period)


def _pumpPHUp():
    _dose_ph(True)


def _pumpPHDown():
    _dose_ph(False)


def _pumpFan():
    """Kipas (relay7) dan pemanas (relay8) berdasarkan suhu/kelembapan udara."""
    global fan, heater, high_temp
    e = threading.Event()
    interval = 1
    while True:
        e.wait(interval)
        if stop_threads:
            break
        if not auto_mode:
            continue
        data = json.loads(r.get(topic).decode())
        high_temp = float(data['config']['fan_air_temp_max'])
        low_temp = float(data['config']['fan_air_temp_min'])
        config_hum = float(data['config']['fan_humidity'])
        dprint(f" >>> AIr Temp'{air_temperature}' HIGH Temp '{high_temp}' hasil'{(air_temperature >= high_temp)}'")

        # --- kipas ON ---
        if ((humidity >= config_hum) or (air_temperature >= high_temp)) and sensor_status and not fan:
            val = 0
            for x in range(9):
                if (humidity >= config_hum) or (air_temperature >= high_temp):
                    val = val + 1
                time.sleep(1)
            if val > 5 and auto_mode:
                fan = True
                set_status(fan=True)
                publish(client, 'on', esp_ac, 'relay7', delayFan)
                time.sleep(delayFan)

        # --- kipas OFF ---
        if (humidity < config_hum) and (air_temperature < (high_temp - 1)) and sensor_status and fan:
            val = 0
            for x in range(9):
                if (humidity < config_hum) and (air_temperature < (high_temp - 1)):
                    val = val + 1
                time.sleep(1)
            if val > 5 and auto_mode:
                fan = False
                set_status(fan=False)
                publish(client, 'off', esp_ac, 'relay7', delayFan)
                time.sleep(5)

        # --- pemanas ON ---
        if (air_temperature <= low_temp) and sensor_status and not heater:
            val = 0
            for x in range(9):
                if air_temperature <= low_temp:
                    val = val + 1
                time.sleep(1)
            if val > 5 and auto_mode:
                publish(client, 'on', esp_ac, 'relay8', delayFan)
                heater = True
                set_status(heater=True)

        # --- pemanas OFF ---
        # PERBAIKAN: syarat asli memeriksa 'fan', bukan 'heater'. Akibatnya pemanas tidak pernah
        # dimatikan selama kipas mati, dan perintah relay8 'off' terkirim terus selama kipas menyala.
        if (air_temperature >= (low_temp + 1)) and sensor_status and heater:
            val = 0
            for x in range(9):
                if air_temperature >= (low_temp + 1):
                    val = val + 1
                time.sleep(1)
            if val > 5 and auto_mode:
                heater = False
                set_status(heater=False)
                publish(client, 'off', esp_ac, 'relay8', delayFan)


def _pumpBalance():
    """Menukar pompa utama A (relay5) <-> B (relay6) bila aliran air rendah."""
    global pump_1, pump_2
    e = threading.Event()
    interval = 1
    print(f"-------------------- A'{pump_1}' B '{pump_2}'")
    while True:
        e.wait(interval)
        if stop_threads:
            break
        if not auto_mode:
            continue
        data = json.loads(r.get(topic).decode())
        waterflow = float(data['config']['waterflow'])
        if (flow <= waterflow) and sensor_status:
            val = 0
            for x in range(30):
                if flow <= waterflow:
                    val = val + 1
                time.sleep(1)
            if val > 28 and auto_mode:
                if pump_1:
                    publish(client, 'off', esp_ac, 'relay5')
                    publish(client, 'on', esp_ac, 'relay6')
                    pump_1, pump_2 = False, True
                    set_status(pump_a=False, pump_b=True)
                elif pump_2:
                    publish(client, 'off', esp_ac, 'relay6')
                    publish(client, 'on', esp_ac, 'relay5')
                    pump_2, pump_1 = False, True
                    set_status(pump_a=True, pump_b=False)
                time.sleep(15)


def _show_datetime():
    """Pengawas sensor. Mode otomatis: bila tidak ada data > check_status detik, matikan semua relay.
    Mode manual: hanya menandai sensor offline, relay tidak disentuh."""
    global sensor_status, pump_1, pump_2, fan, heater, pump_ec_a, pump_ec_b, pump_ph_up, pump_ph_down
    e = threading.Event()
    interval = 1
    while True:
        e.wait(interval)
        if stop_threads:
            break
        # PERBAIKAN: .seconds hanya bagian detik dari timedelta (0-86399); selisih 2 hari + 5 detik
        # dibaca "5 detik" sehingga sensor yang sudah lama mati dianggap hidup.
        silent_for = (datetime.now() - last_active).total_seconds()
        if silent_for < check_status:
            if not sensor_status:
                # sensor pulih: nyalakan lagi pompa utama yang aktif (hanya mode otomatis;
                # di mode manual relay adalah urusan pengguna)
                if auto_mode:
                    if pump_1:
                        publish(client, 'off', esp_ac, 'relay6')
                        publish(client, 'on', esp_ac, 'relay5')
                    elif pump_2:
                        publish(client, 'off', esp_ac, 'relay5')
                        publish(client, 'on', esp_ac, 'relay6')
                sensor_status = True
        else:
            if sensor_status and not auto_mode:
                # Mode manual = kendali penuh pengguna: relay TIDAK disentuh. Hanya nilai sensor
                # dinolkan di Redis dan sensor_online menjadi false (status relay tetap apa adanya).
                sensor_status = False
                update_state(lambda d: d['value'].update(ec=0.0, ph=0.0, temp_water=0.0, temp_air=0.0,
                                                         humidity=0.0, waterflow=0.0))
                print('Sensor tidak mengirim data (mode manual): relay tidak diubah')
            elif sensor_status:
                sensor_status = False
                data = update_state(_reset_state)
                # PERBAIKAN: relay dikembalikan ke keadaan aman (hanya pompa A menyala), jadi variabel internal
                # harus ikut. Sebelumnya fan/heater/pump_2 tetap True sehingga kendali otomatis salah
                # menganggap kipas sudah menyala dan tidak menyalakannya setelah sensor pulih.
                pump_1, pump_2 = True, False
                fan = heater = False
                pump_ec_a = pump_ec_b = pump_ph_up = pump_ph_down = False
                dprint(f"new data '{json.dumps(data)}'")
                publish(client, 'off', esp_dc, 'relay1')
                publish(client, 'off', esp_dc, 'relay2')
                publish(client, 'off', esp_dc, 'relay3')
                publish(client, 'off', esp_dc, 'relay4')
                publish(client, 'on', esp_ac, 'relay5')
                publish(client, 'off', esp_ac, 'relay6')
                publish(client, 'off', esp_ac, 'relay7')
                publish(client, 'off', esp_ac, 'relay8')


def _supervised(fn):
    """PERBAIKAN: di kode asli, satu galat tak terduga (Redis putus, JSON rusak) mematikan thread
    itu selamanya tanpa ada yang tahu. Sekarang dicatat lalu dijalankan ulang setelah 5 detik."""
    def runner():
        while not stop_threads:
            try:
                fn()
                return
            except Exception as error:
                print(f'{fn.__name__}: galat tak terduga {error!r}; dijalankan ulang 5 detik lagi')
                time.sleep(5)
    runner.__name__ = fn.__name__
    return runner


def _spawn(fn):
    threading.Thread(target=_supervised(fn), daemon=True).start()


time.sleep(5)


def start_all():
    for fn in (_show_datetime, _relay_start, _pumpEC, _pumpPHUp, _pumpPHDown, _pumpBalance, _pumpFan):
        _spawn(fn)
    if tb_start():
        _spawn(_uploadThingsboard)
        _spawn(_remoteWorker)
    # PERBAIKAN: loop_forever(30, 1, True) tidak valid di paho 2.x (parameter max_packets dihapus)
    client.loop_forever(retry_first_connection=True)


def destroy_all(*_):
    """Berhenti dengan rapi. Juga dipasang sebagai penangan SIGINT/SIGTERM (mis. systemctl stop)."""
    global stop_threads
    stop_threads = True
    time.sleep(2)
    client.disconnect()          # membuat loop_forever() kembali
    if tb_token:
        tb_client.loop_stop()
        tb_client.disconnect()
    sys.exit()


if __name__ == '__main__':
    signal.signal(signal.SIGINT, destroy_all)
    signal.signal(signal.SIGTERM, destroy_all)
    start_all()
