const mongoose = require('mongoose');

const screenPersonSchema = new mongoose.Schema({
  idNumber: { type: String, required: true, unique: true },
  name: String,
  birth: String,
  education: String,
  phone: String,
  address: String,
  dateUpdated: String,
  items: {
    healthCheck: { type: Boolean, default: false },
    bc: { type: Boolean, default: false },
    papSmear: { type: Boolean, default: false },
    hpv: { type: Boolean, default: false },
    colonScreen: { type: Boolean, default: false },
    oralScreen: { type: Boolean, default: false },
    icp: { type: Boolean, default: false },
    gastricCancer: { type: Boolean, default: false }
  }
});

module.exports = function createScreenPersonModel(mongooseOrConnection) {
  const conn = mongooseOrConnection.models ? mongooseOrConnection.connection : mongooseOrConnection;
  return conn.models.ScreenPerson || conn.model('ScreenPerson', screenPersonSchema);
};
