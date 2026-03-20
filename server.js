require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const WebPerson = require('./WebPerson');
const createScreenPersonModel = require('./ScreenPerson');

const app = express();
const PORT = Number(process.env.PORT || 3001);

const WEB_MONGODB_URI = process.env.WEB_MONGODB_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/personsDB';
const WEB_DB_NAME = process.env.WEB_DB_NAME || 'personsDB';

const WEB_API_TOKEN = process.env.WEB_API_TOKEN || process.env.API_TOKEN;
const SCREEN_API_TOKEN = process.env.SCREEN_API_TOKEN || process.env.API_TOKEN;
const KEEPALIVE_TOKEN = process.env.KEEPALIVE_TOKEN;
const REMOTE_SCREEN_API_BASE_URL = process.env.REMOTE_SCREEN_API_BASE_URL;
const REMOTE_SCREEN_API_TOKEN = process.env.REMOTE_SCREEN_API_TOKEN;

const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '100kb';
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Token', 'X-Keepalive-Token'],
  optionsSuccessStatus: 204
};

app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

mongoose.connect(WEB_MONGODB_URI, {
  dbName: WEB_DB_NAME
});

mongoose.connection.on('connected', () => {
  console.log(`✅ Web DB 連線成功: ${WEB_DB_NAME}`);
});

mongoose.connection.on('error', (err) => {
  console.error('❌ Web DB 連線錯誤:', err.message);
});

const ScreenPerson = createScreenPersonModel(mongoose);

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readToken(req, headerName) {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers[headerName];
  return bearerToken || headerToken;
}

function verifyToken(expectedToken, headerName, missingEnvMessage, invalidMessage) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      return next();
    }

    if (!expectedToken) {
      return res.status(500).json({ message: missingEnvMessage });
    }

    const providedToken = readToken(req, headerName);
    if (!providedToken || String(providedToken) !== String(expectedToken)) {
      return res.status(401).json({ message: invalidMessage });
    }

    return next();
  };
}

const verifyWebApiToken = verifyToken(
  WEB_API_TOKEN,
  'x-api-token',
  '伺服器未設定 WEB_API_TOKEN (或 API_TOKEN)',
  'Web API token 驗證失敗'
);

const verifyScreenApiToken = verifyToken(
  SCREEN_API_TOKEN,
  'x-api-token',
  '伺服器未設定 SCREEN_API_TOKEN (或 API_TOKEN)',
  'Screen API token 驗證失敗'
);

const verifyKeepAliveToken = verifyToken(
  KEEPALIVE_TOKEN,
  'x-keepalive-token',
  '伺服器未設定 KEEPALIVE_TOKEN',
  'keep-alive token 驗證失敗'
);

function toRocBirthCompact(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return trimmed;
  }

  const westernYear = Number(match[1]);
  if (!Number.isInteger(westernYear) || westernYear <= 1911) {
    return trimmed;
  }

  return `${westernYear - 1911}${match[2]}${match[3]}`;
}

function isValidIdNumber(value) {
  return typeof value === 'string' && value.trim().length === 10;
}

function truncateString(value, maxLength) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim().slice(0, maxLength);
}

function getTodayInTaiwanISO() {
  const now = new Date();
  now.setHours(now.getHours() + 8);
  return now.toISOString().split('T')[0];
}

function extractBirthParts(birth) {
  if (typeof birth !== 'string') {
    return { birthYear: '', birthMonth: '', birthDay: '' };
  }

  const compact = birth.replace(/[^0-9]/g, '');
  if (compact.length < 6) {
    return { birthYear: '', birthMonth: '', birthDay: '' };
  }

  const birthDay = compact.slice(-2);
  const birthMonth = compact.slice(-4, -2);
  const birthYear = compact.slice(0, -4);
  return { birthYear, birthMonth, birthDay };
}

function normalizeItems(items = {}) {
  const keys = ['healthCheck', 'bc', 'papSmear', 'hpv', 'colonScreen', 'oralScreen', 'icp', 'gastricCancer'];
  const normalized = {};

  for (const key of keys) {
    normalized[key] = Boolean(items[key]);
  }

  return normalized;
}

function sanitizeScreenPayload(input) {
  return {
    idNumber: String(input.idNumber || '').trim(),
    name: truncateString(input.name, 50),
    birth: truncateString(input.birth, 20),
    education: truncateString(input.education, 50),
    phone: truncateString(input.phone, 30),
    address: truncateString(input.address, 200),
    dateUpdated: truncateString(input.dateUpdated, 20) || getTodayInTaiwanISO(),
    items: normalizeItems(input.items || {})
  };
}

async function fetchRemoteScreenPersons() {
  if (!REMOTE_SCREEN_API_BASE_URL) {
    throw new Error('未設定 REMOTE_SCREEN_API_BASE_URL');
  }

  if (!REMOTE_SCREEN_API_TOKEN) {
    throw new Error('未設定 REMOTE_SCREEN_API_TOKEN');
  }

  if (typeof fetch !== 'function') {
    throw new Error('目前 Node.js 版本不支援 fetch，請升級到 Node 18+');
  }

  const url = `${REMOTE_SCREEN_API_BASE_URL.replace(/\/$/, '')}/screen/persons`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'x-api-token': REMOTE_SCREEN_API_TOKEN
    }
  });

  if (!response.ok) {
    throw new Error(`遠端 API 回傳 ${response.status}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data.persons)) {
    return data.persons;
  }
  throw new Error('遠端資料格式不正確');
}

app.get('/healthz', (_req, res) => {
  res.status(204).send();
});

app.get('/keepalive', verifyKeepAliveToken, (_req, res) => {
  res.status(204).send();
});

// Web API: 保留原路徑
app.get('/person/:idNumber', verifyWebApiToken, asyncHandler(async (req, res) => {
  const idNumber = String(req.params.idNumber || '').trim();
  if (!isValidIdNumber(idNumber)) {
    return res.status(400).json({ message: 'idNumber 格式錯誤' });
  }

  const person = await WebPerson.findOne({ idNumber }).lean();
  if (!person) {
    return res.status(404).json({ message: '查無資料' });
  }

  const { name, birth, education, phone, address } = person;
  return res.json({ name, birth, education, phone, address });
}));

app.post('/person', asyncHandler(async (req, res) => {
  const {
    idNumber, name, birth, education, phone, address
  } = req.body;

  if (!isValidIdNumber(idNumber)) {
    return res.status(400).json({ message: 'idNumber 格式錯誤' });
  }

  const normalizedBirth = toRocBirthCompact(birth);
  const payload = {
    idNumber: idNumber.trim(),
    name: truncateString(name, 50),
    birth: truncateString(normalizedBirth, 20),
    education: truncateString(education, 50),
    phone: truncateString(phone, 30),
    address: truncateString(address, 200)
  };

  const person = await WebPerson.findOne({ idNumber: payload.idNumber });
  if (person) {
    Object.assign(person, payload);
    await person.save();
    return res.json({ message: '更新成功' });
  }

  await WebPerson.create(payload);
  return res.json({ message: '新增成功' });
}));

// Screen API: 第二組 API 掛在 /screen 前綴
app.get('/screen/person/:idNumber', verifyScreenApiToken, asyncHandler(async (req, res) => {
  const idNumber = String(req.params.idNumber || '').trim();
  if (!isValidIdNumber(idNumber)) {
    return res.status(400).json({ message: 'idNumber 格式錯誤' });
  }

  const person = await ScreenPerson.findOne({ idNumber }).lean();
  if (!person) {
    return res.status(404).json({ message: '查無資料' });
  }

  const { name, birth, education, phone, address, items } = person;
  return res.json({ name, birth, education, phone, address, items });
}));

app.post('/screen/person', verifyScreenApiToken, asyncHandler(async (req, res) => {
  const {
    idNumber, name, birth, education, phone, address, items = {}
  } = req.body;

  if (!isValidIdNumber(idNumber)) {
    return res.status(400).json({ message: 'idNumber 格式錯誤' });
  }

  const payload = sanitizeScreenPayload({
    idNumber,
    name,
    birth,
    education,
    phone,
    address,
    dateUpdated: getTodayInTaiwanISO(),
    items
  });

  const person = await ScreenPerson.findOne({ idNumber: payload.idNumber });
  if (person) {
    person.name = payload.name;
    person.birth = payload.birth;
    person.education = payload.education;
    person.phone = payload.phone;
    person.address = payload.address;
    person.dateUpdated = payload.dateUpdated;
    person.items = { ...person.items, ...payload.items };
    await person.save();
    return res.json({ message: '更新成功' });
  }

  await ScreenPerson.create(payload);
  return res.json({ message: '新增成功' });
}));

app.get('/screen/persons', verifyScreenApiToken, asyncHandler(async (_req, res) => {
  const persons = await ScreenPerson.find({}).lean();
  return res.json({ persons });
}));

app.post('/screen/sync-from-remote', verifyScreenApiToken, asyncHandler(async (_req, res) => {
  const remotePersons = await fetchRemoteScreenPersons();

  let inserted = 0;
  let existed = 0;
  let skippedInvalid = 0;

  for (const remotePerson of remotePersons) {
    const sanitized = sanitizeScreenPayload(remotePerson || {});
    if (!isValidIdNumber(sanitized.idNumber)) {
      skippedInvalid += 1;
      continue;
    }

    const exists = await ScreenPerson.exists({ idNumber: sanitized.idNumber });
    if (exists) {
      // 本地優先: 有相同 idNumber 就不覆蓋
      existed += 1;
      continue;
    }

    await ScreenPerson.create(sanitized);
    inserted += 1;
  }

  return res.json({
    message: '同步完成',
    totalRemote: remotePersons.length,
    inserted,
    existed,
    skippedInvalid
  });
}));

app.get('/screen/export', verifyScreenApiToken, asyncHandler(async (req, res) => {
  const { date } = req.query;
  const filter = date ? { dateUpdated: String(date) } : {};
  const persons = await ScreenPerson.find(filter).lean();

  if (persons.length === 0) {
    return res.status(404).send('查無資料');
  }

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('People');
  worksheet.columns = [
    { header: '身分證字號', key: 'idNumber', width: 15 },
    { header: '姓名', key: 'name', width: 10 },
    { header: '生日(年)', key: 'birthYear', width: 10 },
    { header: '生日(月)', key: 'birthMonth', width: 10 },
    { header: '生日(日)', key: 'birthDay', width: 10 },
    { header: '學歷', key: 'education', width: 10 },
    { header: '電話', key: 'phone', width: 15 },
    { header: '住址', key: 'address', width: 30 },
    { header: '更新日期', key: 'dateUpdated', width: 12 },
    { header: '健檢', key: 'healthCheck', width: 8 },
    { header: 'BC', key: 'bc', width: 8 },
    { header: '子抹', key: 'papSmear', width: 8 },
    { header: 'HPV', key: 'hpv', width: 8 },
    { header: '腸篩', key: 'colonScreen', width: 8 },
    { header: '口篩', key: 'oralScreen', width: 8 },
    { header: 'ICP', key: 'icp', width: 8 },
    { header: '胃癌', key: 'gastricCancer', width: 8 }
  ];

  for (const person of persons) {
    const { birthYear, birthMonth, birthDay } = extractBirthParts(person.birth);
    worksheet.addRow({
      idNumber: person.idNumber,
      name: person.name,
      birthYear,
      birthMonth,
      birthDay,
      education: person.education,
      phone: person.phone,
      address: person.address,
      dateUpdated: person.dateUpdated,
      healthCheck: person.items?.healthCheck ?? false,
      bc: person.items?.bc ?? false,
      papSmear: person.items?.papSmear ?? false,
      hpv: person.items?.hpv ?? false,
      colonScreen: person.items?.colonScreen ?? false,
      oralScreen: person.items?.oralScreen ?? false,
      icp: person.items?.icp ?? false,
      gastricCancer: person.items?.gastricCancer ?? false
    });
  }

  const exportPath = path.join(process.cwd(), `export_${Date.now()}.xlsx`);
  await workbook.xlsx.writeFile(exportPath);

  return res.download(exportPath, `人員資料匯出_${date || '全部'}.xlsx`, (err) => {
    fs.unlink(exportPath, () => {});
    if (err) {
      console.error('下載時發生錯誤:', err.message);
    }
  });
}));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ message: '伺服器錯誤' });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
