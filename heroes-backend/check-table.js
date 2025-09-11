const { pool } = require('./config/database');

async function checkTable() {
  try {
    console.log('🔍 Checking heroes_tbl structure...');
    
    // Show table structure
    const [columns] = await pool.execute('DESCRIBE heroes_tbl');
    console.log('\n📋 Table Structure:');
    console.table(columns);
    
    // Show existing data
    const [rows] = await pool.execute('SELECT * FROM heroes_tbl LIMIT 5');
    console.log(`\n📊 Sample Data (${rows.length} rows):`);
    if (rows.length > 0) {
      console.table(rows);
    } else {
      console.log('No data found in heroes_tbl');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error checking table:', error.message);
    process.exit(1);
  }
}

checkTable();