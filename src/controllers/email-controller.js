const {EmailService} = require('../services');

async function create(res,req,next){
    try {
        const response = await EmailService.createTicket({
            subject: req.body.subject,
            content:req.body.content,
            recepientEmail:req.body.recepientEmail
        })
        return res.status(201).json(response);
    } catch (error) {
        res.status(500).json(error);
    }
    next();
}

module.exports = {
    create
}