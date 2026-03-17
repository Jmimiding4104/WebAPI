require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const WebPerson = require('./WebPerson');

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/personsDB';
const API_TOKEN = process.env.API_TOKEN;

// 中介軟體
app.use(bodyParser.json());

function verifyApiToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({ message: '伺服器未設定 API_TOKEN' });
  }

  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers['x-api-token'];
  const providedToken = bearerToken || headerToken;

  if (!providedToken || String(providedToken) !== String(API_TOKEN)) {
    return res.status(401).json({ message: 'API token 驗證失敗' });
  }

  next();
}

// 連接 MongoDB
mongoose.connect(MONGODB_URI, {
  dbName: 'personsDB',
  useNewUrlParser: true,
  useUnifiedTopology: true
});

mongoose.connection.on('connected', () => {
    console.log('✅ MongoDB 連線成功');
  });
  
  mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB 連線錯誤:', err);
  });

// 查詢個人資料
app.get('/person/:idNumber', verifyApiToken, async (req, res) => {
  const person = await WebPerson.findOne({ idNumber: req.params.idNumber });
  if (person) {
    const { name, birth, education, phone, address } = person;
    res.json({ name, birth, education, phone, address});
  } else {
    res.status(404).json({ message: '查無資料' });
  }
});

// 新增或更新個人資料
app.post('/person', async (req, res) => {
  const {
    idNumber, name, birth, education, phone, address
  } = req.body;

  let person = await WebPerson.findOne({ idNumber });

  if (person) {
    // 更新
    person.name = name;
    person.birth = birth;
    person.education = education;
    person.phone = phone;
    person.address = address;
    await person.save();
    res.json({ message: '更新成功' });
  } else {
    // 新增
    person = new WebPerson({
      idNumber, name, birth, education, phone, address
    });
    await person.save();
    res.json({ message: '新增成功' });
  }
});  

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
