"""Paragon Crisis Portal on Streamlit.

The portal is a static web app (HTML + JavaScript, data embedded). Streamlit serves the folder static/ and shows
static/index.html full-page, so everything runs in the visitor's browser.
Rebuild the static copy after a change:  python src/build_app.py  then copy app/ to static/.
Not available on Streamlit: the live water levels that need the local helper (Rijkswaterstaat, NRW, Waterschap Limburg)
and the AI assistant, because both call a helper on 127.0.0.1 that only exists on a computer where live/live_proxy.py runs.
"""
import streamlit as st

st.set_page_config(page_title="Paragon Crisis Portal", page_icon=None, layout="wide", initial_sidebar_state="collapsed")
st.markdown(
    """<style>
    header, footer, #MainMenu, [data-testid="stToolbar"], [data-testid="stDecoration"] { display:none !important; }
    .block-container, [data-testid="stMainBlockContainer"] { padding:0 !important; max-width:100% !important; }
    iframe { width:100% !important; height:100vh !important; border:0 !important; display:block; }
    .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"] { background:#0e1116 !important; }
    [data-testid="stMain"], [data-testid="stMainBlockContainer"] { padding:0 !important; }
    [data-testid="stVerticalBlock"] { gap:0 !important; }
    .stElementContainer { margin:0 !important; }
    </style>""",
    unsafe_allow_html=True,
)
import streamlit.components.v1 as components
components.iframe("app/static/index.html", height=900, scrolling=True)
