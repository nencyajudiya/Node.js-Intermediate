import app from './app.js';

const PORT = 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${ 'development'}`);
    console.log(`Serving static files from: ./public`);
    console.log(`Open: http://localhost:${PORT}/`);
});
