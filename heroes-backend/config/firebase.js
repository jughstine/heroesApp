const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

// Initialize Firebase Admin SDK only once
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error);
    throw error;
  }
} else {
}

// Export the admin instance
module.exports = admin;