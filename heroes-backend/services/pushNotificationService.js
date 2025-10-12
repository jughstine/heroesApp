const { Expo } = require('expo-server-sdk');

const expo = new Expo();

/**
 * Send push notification to a user
 * @param {string} pushToken - User's Expo push token
 * @param {object} notification - Notification details
 */
const sendPushNotification = async (pushToken, notification) => {
  // Check that the push token is valid
  if (!Expo.isExpoPushToken(pushToken)) {
    console.error(`Push token ${pushToken} is not a valid Expo push token`);
    return { success: false, error: 'Invalid push token' };
  }

  // Construct the message
  const message = {
    to: pushToken,
    sound: 'default',
    title: notification.title || 'AFPPGMC Notification',
    body: notification.body,
    data: notification.data || {},
    priority: 'high',
    badge: notification.badge || 1,
  };

  try {
    const ticketChunk = await expo.sendPushNotificationsAsync([message]);
    console.log('Push notification sent:', ticketChunk);
    return { success: true, ticket: ticketChunk[0] };
  } catch (error) {
    console.error('Error sending push notification:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Send notification for form approval
 */
const sendFormApprovalNotification = async (pushToken, formDetails) => {
  const formTypeNames = {
    1: "Declaration of Legal Beneficiary",
    2: "Resumption",
    3: "Restoration",
    4: "Transfer of Pension",
    5: "Updating"
  };

  const formName = formTypeNames[formDetails.form_type_id] || 'Form';

  return await sendPushNotification(pushToken, {
    title: '✅ Form Approved',
    body: `Your ${formName} application has been approved!`,
    data: {
      type: 'form_approval',
      form_id: formDetails.form_id,
      form_type_id: formDetails.form_type_id,
      screen: 'Submissions'
    },
    badge: 1
  });
};

/**
 * Send notification for form denial
 */
const sendFormDenialNotification = async (pushToken, formDetails) => {
  const formTypeNames = {
    1: "Declaration of Legal Beneficiary",
    2: "Resumption",
    3: "Restoration",
    4: "Transfer of Pension",
    5: "Updating"
  };

  const formName = formTypeNames[formDetails.form_type_id] || 'Form';

  return await sendPushNotification(pushToken, {
    title: '❌ Form Declined',
    body: `Your ${formName} application has been declined. Please check for details.`,
    data: {
      type: 'form_denial',
      form_id: formDetails.form_id,
      form_type_id: formDetails.form_type_id,
      screen: 'Submissions'
    },
    badge: 1
  });
};

/**
 * Send notification for admin notes
 */
const sendAdminNotesNotification = async (pushToken, formDetails) => {
  return await sendPushNotification(pushToken, {
    title: '📝 New Admin Note',
    body: 'An administrator has added a note to your form submission.',
    data: {
      type: 'admin_note',
      form_id: formDetails.form_id,
      form_type_id: formDetails.form_type_id,
      screen: 'Submissions'
    },
    badge: 1
  });
};

module.exports = {
  sendPushNotification,
  sendFormApprovalNotification,
  sendFormDenialNotification,
  sendAdminNotesNotification
};