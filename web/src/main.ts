import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles.css'

const theme = new URLSearchParams(window.location.search).get('theme')
if (theme === 'dark') document.documentElement.classList.add('dark')
if (theme === 'light') document.documentElement.classList.remove('dark')

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
