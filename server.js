const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

// Supabase configuration
const supabase = createClient(
    process.env.SUPABASE_URL.trim(),
    process.env.SUPABASE_KEY.trim()
);

app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
app.use(bodyParser.json());

// Health check route
app.get('/', (req, res) => res.send('Server is running!'));

//route to fetch order types
app.get('/order-types', async (req, res) => {
    try {
        const { data, error } = await supabase.from('order_types').select('*');
        
        if (error) throw error;
        
        res.status(200).json(data.map(type => type.name));
    } catch (error) {
        console.error('Error fetching order types:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to add a new order type
app.post('/order-types', async (req, res) => {
    const { name } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'Order type name is required' });
    }
    
    try {
        const { data, error } = await supabase
            .from('order_types')
            .insert([{ name }])
            .select();
        
        if (error) throw error;
        
        res.status(201).json(data[0]);
    } catch (error) {
        console.error('Error adding order type:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route to delete an order type
app.delete('/order-types/:name', async (req, res) => {
    const { name } = req.params;
    
    try {
        const { error } = await supabase
            .from('order_types')
            .delete()
            .eq('name', name);
        
        if (error) throw error;
        
        res.status(200).json({ message: 'Order type deleted successfully' });
    } catch (error) {
        console.error('Error deleting order type:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add a new order
app.post('/orders', async (req, res) => {
    const { 
        order_type, 
        deadline, 
        total_amount, 
        payment_status = 'Not Paid', 
        amount_paid = 0, 
        client_name, 
        client_phone, 
        notes 
    } = req.body;

    // Calculate remaining balance
    const remaining_balance = total_amount - amount_paid;

    // Simple tax calculation (5%)
    const tax = total_amount * 0.05;
    const subtotal = total_amount - tax;

    if (!order_type || !deadline || !client_name || total_amount == null) {
        return res.status(400).json({ error: 'Order type, deadline, client name, and total amount are required.' });
    }

    try {
        // Insert order into the orders table
        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .insert([{ 
                order_type, 
                deadline, 
                total_amount,
                payment_status,
                amount_paid,
                remaining_balance,
                client_name, 
                client_phone, 
                notes 
            }])
            .select();

        if (orderError) throw orderError;

        // Generate invoice for the new order
        const invoiceNumber = `INV-${Date.now()}`;
        const invoiceData = {
            order_id: orderData[0].id,
            invoice_number: invoiceNumber,
            total_amount: total_amount,
            amount_paid: amount_paid,
            remaining_balance: remaining_balance,
            subtotal: subtotal,
            tax: tax,
            issue_date: new Date().toISOString().split('T')[0],
            status: payment_status === 'Paid' ? 'paid' : 'pending'
        };
        
        const { data: savedInvoiceData, error: invoiceError } = await supabase
            .from('invoices')
            .insert([invoiceData])
            .select();

        if (invoiceError) throw invoiceError;

        res.status(201).json({
            order: orderData[0],
            invoice: savedInvoiceData[0]
        });
    } catch (error) {
        console.error('Error creating order:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Fetch all orders
app.get('/orders', async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders').select('*');

        if (error) {
            console.error('Supabase Error:', error);
            return res.status(500).json({ error: 'Failed to retrieve orders', details: error.message });
        }

        res.status(200).json(data);
    } catch (err) {
        console.error('Unexpected Error:', err);
        res.status(500).json({ error: 'Unexpected server error', details: err.message });
    }
});

// Fetch a specific invoice by order_id
app.get('/invoices/:order_id', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('invoices')
            .select('*, orders(*)')
            .eq('order_id', req.params.order_id)
            .single();

        if (error) {
            console.error('Supabase Error:', error.message);
            throw error;
        }

        res.status(200).json(data);
    } catch (error) {
        console.error('Error Fetching Invoice:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Route to update payment status
app.patch('/orders/:id', async (req, res) => {
    const { id } = req.params;
    const { payment_status } = req.body;

    // Validate input
    if (!payment_status) {
        return res.status(400).json({ error: 'Payment status is required' });
    }

    try {
        // Fetch the current order to get total_amount
        const { data: orderData, error: fetchError } = await supabase
            .from('orders')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchError) throw fetchError;

        // Update order payment status
        const { data, error } = await supabase
            .from('orders')
            .update({ 
                payment_status,
                // Directly set amount_paid to total_amount if paid
                amount_paid: payment_status === 'Paid' ? orderData.total_amount : orderData.amount_paid,
                remaining_balance: payment_status === 'Paid' ? 0 : orderData.remaining_balance
            })
            .eq('id', id)
            .select();

        if (error) throw error;

        // Update corresponding invoice status
        await supabase
            .from('invoices')
            .update({ 
                status: payment_status === 'Paid' ? 'paid' : 'pending',
                amount_paid: payment_status === 'Paid' ? orderData.total_amount : null
            })
            .eq('order_id', id);

        res.status(200).json(data[0]);
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: error.message });
    }
});
// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
