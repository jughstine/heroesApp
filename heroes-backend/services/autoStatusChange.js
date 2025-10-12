const cron = require('node-cron');
const { executeQuery, logger } = require('../config/database');

/**
 * Automatic Status Change System - Calendar Year Based
 */

const YEARLY_CYCLES = [
  { cycle: 1, startDay: 1, endDay: 75, name: 'Cycle 1 (Jan 1 - Mar 16)' },
  { cycle: 2, startDay: 76, endDay: 150, name: 'Cycle 2 (Mar 17 - May 30)' },
  { cycle: 3, startDay: 151, endDay: 225, name: 'Cycle 3 (May 31 - Aug 13)' },
  { cycle: 4, startDay: 226, endDay: 300, name: 'Cycle 4 (Aug 14 - Oct 27)' },
  { cycle: 5, startDay: 301, endDay: 365, name: 'Cycle 5 (Oct 28 - Dec 31)' }
];

const autoStatusChangeService = {
  
  getDayOfYear(date = new Date()) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  },

  getCurrentCycle(date = new Date()) {
    const dayOfYear = this.getDayOfYear(date);
    return YEARLY_CYCLES.find(cycle => 
      dayOfYear >= cycle.startDay && dayOfYear <= cycle.endDay
    ) || null;
  },

  getCycleFromDate(date) {
    if (!date) return null;
    const dateObj = new Date(date);
    const dayOfYear = this.getDayOfYear(dateObj);
    return YEARLY_CYCLES.find(cycle => 
      dayOfYear >= cycle.startDay && dayOfYear <= cycle.endDay
    )?.cycle || null;
  },

  hasSubmittedInCurrentYear(lastSubmissionDate) {
    if (!lastSubmissionDate) return false;
    const lastSubmission = new Date(lastSubmissionDate);
    const now = new Date();
    return lastSubmission.getFullYear() === now.getFullYear();
  },

  getLastSubmissionCycle(lastSubmissionDate) {
    if (!this.hasSubmittedInCurrentYear(lastSubmissionDate)) {
      return null; // No submission in current year
    }
    return this.getCycleFromDate(lastSubmissionDate);
  },

  async updateInactiveTAGUsers() {
    try {
      logger.info('Starting TAG → DEL status update check (Cycle-based)');

      const currentCycle = this.getCurrentCycle();
      if (!currentCycle) {
        logger.warn('Could not determine current cycle');
        return 0;
      }

      logger.info(`Current cycle: ${currentCycle.name}`);

      // Calculate the start date of current cycle
      const now = new Date();
      const currentYear = now.getFullYear();
      const cycleStartDate = new Date(currentYear, 0, currentCycle.startDay);

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'DEL',
          status_updated_at = NOW(),
          deleted_at = NOW()
        WHERE status = 'TAG'
          AND (
            -- No activity in current cycle
            COALESCE(status_updated_at, tagged_at, created_at) < ?
            OR 
            -- Activity was in previous year
            YEAR(COALESCE(status_updated_at, tagged_at, created_at)) < YEAR(NOW())
          )
      `, [cycleStartDate]);

      if (result.affectedRows > 0) {
        logger.info(`✓ Updated ${result.affectedRows} TAG users to DEL status`);
        
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

  async updateInactiveACTUsers() {
    try {
      logger.info('Starting ACT → TAG status update check (Cycle-based)');

      const currentCycle = this.getCurrentCycle();
      if (!currentCycle) {
        logger.warn('Could not determine current cycle');
        return 0;
      }

      logger.info(`Current cycle: ${currentCycle.name}`);

      // Calculate the start date of current cycle
      const now = new Date();
      const currentYear = now.getFullYear();
      const cycleStartDate = new Date(currentYear, 0, currentCycle.startDay);

      const result = await executeQuery(`
        UPDATE users_tbl 
        SET 
          status = 'TAG',
          status_updated_at = NOW(),
          tagged_at = NOW()
        WHERE status = 'ACT'
          AND (
            -- No form submission in current cycle
            COALESCE(form_submitted_at, approved_at, created_at) < ?
            OR 
            -- Last submission was in previous year
            YEAR(COALESCE(form_submitted_at, approved_at, created_at)) < YEAR(NOW())
          )
      `, [cycleStartDate]);

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

  async runStatusUpdates() {
    const startTime = Date.now();
    logger.info('=== Starting Automatic Status Update Job (Calendar Cycle-based) ===');

    const currentCycle = this.getCurrentCycle();
    logger.info(`Current Cycle: ${currentCycle?.name || 'Unknown'}`);
    logger.info(`Day of Year: ${this.getDayOfYear()}`);

    try {
      const tagToDelCount = await this.updateInactiveTAGUsers();
      const actToTagCount = await this.updateInactiveACTUsers();

      const processingTime = Date.now() - startTime;
      logger.info(`=== Status Update Job Completed in ${processingTime}ms ===`);
      logger.info(`Summary: ${tagToDelCount} deleted, ${actToTagCount} tagged`);

      return {
        success: true,
        currentCycle: currentCycle?.cycle,
        cycleName: currentCycle?.name,
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

  async getUsersApproachingStatusChange() {
    try {
      const currentCycle = this.getCurrentCycle();
      if (!currentCycle) {
        return { tagUsersNearDeletion: [], actUsersNearTagging: [] };
      }

      const dayOfYear = this.getDayOfYear();
      const daysLeftInCycle = currentCycle.endDay - dayOfYear;
      
      // Only warn if within last 7 days of cycle
      if (daysLeftInCycle > 7) {
        return { tagUsersNearDeletion: [], actUsersNearTagging: [] };
      }

      const currentYear = new Date().getFullYear();
      const cycleStartDate = new Date(currentYear, 0, currentCycle.startDay);

      // TAG users who will be deleted at end of cycle (no activity in current cycle)
      const tagUsersNearDeletion = await executeQuery(`
        SELECT 
          id, 
          email, 
          status,
          COALESCE(status_updated_at, tagged_at, created_at) as last_activity,
          ? as days_remaining,
          ? as cycle_number,
          ? as cycle_name
        FROM users_tbl 
        WHERE status = 'TAG'
          AND (
            COALESCE(status_updated_at, tagged_at, created_at) < ?
            OR YEAR(COALESCE(status_updated_at, tagged_at, created_at)) < YEAR(NOW())
          )
        ORDER BY last_activity ASC
      `, [daysLeftInCycle, currentCycle.cycle, currentCycle.name, cycleStartDate]);

      // ACT users who will be tagged at end of cycle (no form submission in current cycle)
      const actUsersNearTagging = await executeQuery(`
        SELECT 
          id, 
          email, 
          status,
          COALESCE(form_submitted_at, approved_at, created_at) as last_activity,
          ? as days_remaining,
          ? as cycle_number,
          ? as cycle_name
        FROM users_tbl 
        WHERE status = 'ACT'
          AND (
            COALESCE(form_submitted_at, approved_at, created_at) < ?
            OR YEAR(COALESCE(form_submitted_at, approved_at, created_at)) < YEAR(NOW())
          )
        ORDER BY last_activity ASC
      `, [daysLeftInCycle, currentCycle.cycle, currentCycle.name, cycleStartDate]);

      return {
        currentCycle: currentCycle.cycle,
        cycleName: currentCycle.name,
        daysLeftInCycle,
        tagUsersNearDeletion,
        actUsersNearTagging
      };
    } catch (error) {
      logger.error('Error fetching users approaching status change:', error);
      throw error;
    }
  },

  /**
   * Get statistics for current cycle
   */
  async getCycleStatistics() {
    try {
      const currentCycle = this.getCurrentCycle();
      if (!currentCycle) {
        return null;
      }

      const currentYear = new Date().getFullYear();
      const cycleStartDate = new Date(currentYear, 0, currentCycle.startDay);

      // Count users by status and their cycle submission status
      const stats = await executeQuery(`
        SELECT 
          status,
          COUNT(*) as total,
          SUM(CASE 
            WHEN COALESCE(form_submitted_at, approved_at, created_at) >= ? 
              AND YEAR(COALESCE(form_submitted_at, approved_at, created_at)) = YEAR(NOW())
            THEN 1 
            ELSE 0 
          END) as submitted_in_cycle,
          SUM(CASE 
            WHEN COALESCE(form_submitted_at, approved_at, created_at) < ? 
              OR YEAR(COALESCE(form_submitted_at, approved_at, created_at)) < YEAR(NOW())
            THEN 1 
            ELSE 0 
          END) as not_submitted_in_cycle
        FROM users_tbl
        WHERE status IN ('ACT', 'TAG', 'DEL')
        GROUP BY status
      `, [cycleStartDate, cycleStartDate]);

      return {
        currentCycle: currentCycle.cycle,
        cycleName: currentCycle.name,
        dayOfYear: this.getDayOfYear(),
        daysLeftInCycle: currentCycle.endDay - this.getDayOfYear(),
        statistics: stats
      };
    } catch (error) {
      logger.error('Error fetching cycle statistics:', error);
      throw error;
    }
  }
};

const scheduleStatusUpdates = () => {
  // Run every day at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    await autoStatusChangeService.runStatusUpdates();
  }, {
    timezone: "Asia/Manila"
  });  
};

const createManualTriggerRoute = (router) => {
  // Manual trigger for status updates
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

  // Get users at risk of status change
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

  // Get current cycle statistics
  router.get('/admin/cycle-statistics', async (req, res) => {
    try {
      const stats = await autoStatusChangeService.getCycleStatistics();
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch cycle statistics',
        details: error.message
      });
    }
  });

  // Get current cycle info
  router.get('/admin/current-cycle', async (req, res) => {
    try {
      const currentCycle = autoStatusChangeService.getCurrentCycle();
      const dayOfYear = autoStatusChangeService.getDayOfYear();
      
      res.json({
        success: true,
        data: {
          cycle: currentCycle?.cycle,
          cycleName: currentCycle?.name,
          dayOfYear: dayOfYear,
          daysLeftInCycle: currentCycle ? currentCycle.endDay - dayOfYear : null,
          cycleStartDay: currentCycle?.startDay,
          cycleEndDay: currentCycle?.endDay
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch current cycle info',
        details: error.message
      });
    }
  });
};

module.exports = {
  autoStatusChangeService,
  scheduleStatusUpdates,
  createManualTriggerRoute,
  YEARLY_CYCLES
};