const mongoose = require('mongoose');

const personSchema = new mongoose.Schema({
  idNumber: { type: String, required: true, unique: true }, // 身分證
  name: String,
  birth: String,         // 生日可用 String 儲存 YYYY-MM-DD
  education: String,     // 學歷
  phone: String,
  address: String,
});

module.exports = mongoose.model('WebPerson', personSchema);
