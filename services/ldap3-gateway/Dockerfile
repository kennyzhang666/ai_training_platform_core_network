FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LDAP_GATEWAY_HOST=0.0.0.0 \
    LDAP_GATEWAY_PORT=8081

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && useradd --system --uid 10001 --create-home gateway

COPY ldap3_gateway.py ./ldap3_gateway.py
COPY static ./static

USER gateway
EXPOSE 8081
CMD ["python", "ldap3_gateway.py"]
