const cron = require('node-cron');
const { executeQuery, logger } = require('../config/database');

/**
 * Automatic Status Change System
 * 
 * Rules (All based on 75 calendar days):
 * 1. TAG status → DEL if no activity within 75 calendar days
 * 2. ACT status → TAG if no form submission within 75 calendar days
 */

const autoStatusChangeService = {
  
  /**
   * Check and update TAG users to DEL (75 calendar days inactive)
   */
  async updateInactiveTAGUsers() {
    try {
      logger.info('Starting TAG → DEL status update check');

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'DEL',
          status_updated_at = NOW(),
          deleted_at = NOW()
        WHERE status = 'TAG'
          AND DATEDIFF(NOW(), COALESCE(status_updated_at, tagged_at, created_at)) >= 75
      `);

      if (result.affectedRows > 0) {
        logger.info(`✓ Updated ${result.affectedRows} TAG users to DEL status`);
        
        // Log affected users for audit trail
        const deletedUsers = await executeQuery(`
          SELECT id, email, status_updated_at, tagged_at, created_at
          FROM users_tbl 
          WHERE status = 'DEL' 
            AND deleted_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        
        logger.info('Deleted users:', deletedUsers.map(u => ({
          id: u.id,
          email: u.email,
          lastActivity: u.status_updated_at || u.tagged_at || u.created_at
        })));
      } else {
        logger.info('No TAG users require deletion');
      }

      return result.affectedRows;
    } catch (error) {
      logger.error('Error updating TAG users to DEL:', error);
      throw error;
    }
  },

  /**
   * Check and update ACT users to TAG (75 calendar days no form submission)
   */
  async updateInactiveACTUsers() {
    try {
      logger.info('Starting ACT → TAG status update check');

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'TAG',
          status_updated_at = NOW(),
          tagged_at = NOW()
        WHERE status = 'ACT'
          AND DATEDIFF(NOW(), COALESCE(form_submitted_at, approved_at, created_at)) >= 75
      `);

      if (result.affectedRows > 0) {
        logger.info(`✓ Updated ${result.affectedRows} ACT users to TAG status`);
        
        // Log affected users
        const taggedUsers = await executeQuery(`
          SELECT id, email, form_submitted_at, approved_at, created_at
          FROM users_tbl 
          WHERE status = 'TAG' 
            AND tagged_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `);
        
        logger.info('Tagged users:', taggedUsers.map(u => ({
          id: u.id,
          email: u.email,
          lastActivity: u.form_submitted_at || u.approved_at || u.created_at
        })));
      } else {
        logger.info('No ACT users require tagging');
      }

      return result.affectedRows;
    } catch (error) {
      logger.error('Error updating ACT users to TAG:', error);
      throw error;
    }
  },

  /**
   * Run both status update checks
   */
  async runStatusUpdates() {
    const startTime = Date.now();
    logger.info('=== Starting Automatic Status Update Job ===');

    try {
      const tagToDelCount = await this.updateInactiveTAGUsers();
      const actToTagCount = await this.updateInactiveACTUsers();

      const processingTime = Date.now() - startTime;
      logger.info(`=== Status Update Job Completed in ${processingTime}ms ===`);
      logger.info(`Summary: ${tagToDelCount} deleted, ${actToTagCount} tagged`);

      return {
        success: true,
        tagToDelCount,
        actToTagCount,
        processingTime
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error(`=== Status Update Job Failed after ${processingTime}ms ===`);
      logger.error(error);
      
      return {
        success: false,
        error: error.message,
        processingTime
      };
    }
  },

  /**
   * Get users approaching status change (warning system)
   */
  async getUsersApproachingStatusChange() {
    try {
      // TAG users within 7 days of deletion (68-74 days inactive)
      const tagUsersNearDeletion = await executeQuery(`
        SELECT 
          id, 
          email, 
          status,
          COALESCE(status_updated_at, tagged_at, created_at) as last_activity,
          DATEDIFF(NOW(), COALESCE(status_updated_at, tagged_at, created_at)) as days_inactive,
          75 - DATEDIFF(NOW(), COALESCE(status_updated_at, tagged_at, created_at)) as days_remaining
        FROM users_tbl 
        WHERE status = 'TAG'
          AND DATEDIFF(NOW(), COALESCE(status_updated_at, tagged_at, created_at)) BETWEEN 68 AND 74
        ORDER BY days_remaining ASC
      `);

      // ACT users within 7 days of being tagged (68-74 days inactive)
      const actUsersNearTagging = await executeQuery(`
        SELECT 
          id, 
          email, 
          status,
          COALESCE(form_submitted_at, approved_at, created_at) as last_activity,
          DATEDIFF(NOW(), COALESCE(form_submitted_at, approved_at, created_at)) as days_inactive,
          75 - DATEDIFF(NOW(), COALESCE(form_submitted_at, approved_at, created_at)) as days_remaining
        FROM users_tbl 
        WHERE status = 'ACT'
          AND DATEDIFF(NOW(), COALESCE(form_submitted_at, approved_at, created_at)) BETWEEN 68 AND 74
        ORDER BY days_remaining ASC
      `);

      return {
        tagUsersNearDeletion,
        actUsersNearTagging
      };
    } catch (error) {
      logger.error('Error fetching users approaching status change:', error);
      throw error;
    }
  }
};

/**
 * Schedule automatic status updates
 * Runs daily at 2:00 AM Manila time
 */
const scheduleStatusUpdates = () => {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    logger.info('Scheduled status update triggered');
    await autoStatusChangeService.runStatusUpdates();
  }, {
    timezone: "Asia/Manila"
  });

  logger.info('✓ Auto-status change cron job scheduled (daily at 2:00 AM Manila time)');
};

/**
 * Manual trigger endpoint (add to your routes)
 */
const createManualTriggerRoute = (router) => {
  router.post('/admin/trigger-status-update', async (req, res) => {
    try {
      const result = await autoStatusChangeService.runStatusUpdates();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to run status update',
        details: error.message
      });
    }
  });

  router.get('/admin/users-at-risk', async (req, res) => {
    try {
      const usersAtRisk = await autoStatusChangeService.getUsersApproachingStatusChange();
      res.json({
        success: true,
        data: usersAtRisk
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch at-risk users',
        details: error.message
      });
    }
  });
};

module.exports = {
  autoStatusChangeService,
  scheduleStatusUpdates,
  createManualTriggerRoute
};